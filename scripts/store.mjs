/**
 * 商店实时检索（Apple App Store / Google Play）
 *
 * 取数方式：Apple 走 iTunes Search API；Google Play 抓搜索页 HTML 并解析卡片。
 *
 * 核心红线：检索失败不得谎报「0 个结果」。
 *   - iTunes：!res.ok → network_failed；返回体不是 results 数组 → parser_failed；
 *             results: [] 属正常「查到了但没有」，ok 仍为 true。
 *   - Google Play：HTTP 失败 / 抛出 → network_failed；页面里有 details?id= 链接
 *             却解析出 0 个应用 → parser_failed（Google 换了混淆类名）。
 * 下游据此决定能不能说「未检索到同名」——见 engine.mjs 的 storeSearchStatus。
 */

import { isRelevant } from './engine.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 商店检索请求超时。两家接口正常都在 1s 内返回，8s 已足够宽松。
 * 必须设：没有超时的话，对方挂住不返回时整个脚本会一直卡住。
 * 超时按 network_failed 处理，下游会如实播报「检索未完成」，不会谎报 0 结果。
 */
const STORE_FETCH_TIMEOUT_MS = 8000;

/**
 * 带一次重试的 fetch。
 *
 * 网络抖动与偶发超时很常见（尤其跨地区访问 Google Play），一次失败就把整个市场判成
 * 「检索未完成」，会让「这个市场到底有没有同名」直接缺位。因此失败后再试一次，
 * 两次之间短暂退避，避免瞬时拥塞时把两个请求挤在同一时刻。
 *
 * 只重试「可能是暂时的」失败：超时、连接错误、5xx、429。
 * 4xx（如 404）重试没有意义，直接返回。
 */
async function fetchWithRetry(url, headers, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(STORE_FETCH_TIMEOUT_MS),
      });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400));
  }
  throw lastErr;
}

/**
 * Google Play 语言码映射（gl 国家码 → hl 语言码）。
 *
 * 不能把国家码直接当 hl：jp / kr / hk / tw / br 都不是合法语言码。
 * 实测传非法值时 Google 不会回退英文，而是回退到未定义语言（hl=br 拿到了法语页面），
 * 且 hl 会改变返回的应用集合 —— gl=jp 下 hl=ja 与 hl=jp 的包名集合不同，
 * 会漏掉真实命中。逐市场结论是本 skill 的核心产出，这一项错了等于结论错了。
 *
 * 未收录市场回退 'en'：它是合法值，不会触发上述未定义行为。
 * 代价是该市场按英文界面检索，真实店铺语言下的应用名可能检索不到 —— 属已知限制，
 * 不要当成「已覆盖本地语言」。
 */
const MARKET_LANGUAGE = {
  // 英语区
  us: 'en', gb: 'en-GB', uk: 'en-GB', ca: 'en-CA', au: 'en-AU',
  sg: 'en', in: 'en-IN', ie: 'en', nz: 'en', za: 'en', ph: 'en',
  // 中文区（hk / tw / mo 分属中国香港 / 中国台湾 / 中国澳门市场，Google 用 zh-HK / zh-TW 区分）
  cn: 'zh-CN', hk: 'zh-HK', tw: 'zh-TW', mo: 'zh-HK',
  // 东亚
  jp: 'ja', kr: 'ko',
  // 欧洲
  de: 'de', at: 'de', fr: 'fr', it: 'it', nl: 'nl', pl: 'pl', cz: 'cs',
  se: 'sv', no: 'no', dk: 'da', fi: 'fi', gr: 'el', ro: 'ro', hu: 'hu',
  ru: 'ru', ua: 'uk', tr: 'tr',
  // 东南亚 / 南亚
  id: 'id', my: 'ms', th: 'th', vn: 'vi',
  // 拉美 / 西语 / 葡语
  br: 'pt-BR', pt: 'pt-PT', mx: 'es-MX', es: 'es-ES', ar: 'es-AR',
  cl: 'es-CL', co: 'es-CO', pe: 'es-PE',
  // 中东
  ae: 'ar', sa: 'ar', eg: 'ar', il: 'iw',
};

/** 国家码 → Google Play 的 hl 语言码。未收录市场回退 en（合法值，不触发未定义回退）。 */
function googlePlayLang(country) {
  return MARKET_LANGUAGE[String(country || '').trim().toLowerCase()] || 'en';
}

/**
 * Google Play 卡片解析兜底。
 *
 * 主解析路径依赖 Google 的混淆类名（vWM94c / DdYX5 / LbQbAe…），这些类名会随 Google 改版失效：
 * 其中一部分已经取不到内容，当前只有 DdYX5 仍能取到名称。类名一变主路径就全空，
 * 幸好有 linkCount 信号把这种情况识别成 parser_failed 而不是「0 个结果」，
 * 但识别出来仍然拿不到数据。这里补一条与类名无关的兜底：
 * 结果卡片内文本节点的第一个是应用名、第二个是开发者（已用多个查询验证）。
 *
 * 兜底命中数 > 0 时会打日志，便于发现主路径已失效、该更新类名了。
 */
function parseCardTextFallback(snippet) {
  const NOISE =
    /^(star|rated\b|screenshot|thumbnail|contains ads|in-app purchases|获评|屏幕|图标|详细|\d+(?:\.\d+)?|\d+[.,]?\d*\s*[KMB]?\+?)$/i;
  const texts = [];
  const re = /<(?:span|div)[^>]*>([^<]{1,120})<\/(?:span|div)>/g;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    const t = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (!t || NOISE.test(t)) continue;
    texts.push(t);
  }
  return { name: texts[0], developer: texts[1] };
}

/** 在片段里找离中心偏移最近的捕获组取值 */
function getClosestRegexMatch(snippet, regexes, centerOffset) {
  let closestVal = '';
  let minDistance = Infinity;
  for (const regex of regexes) {
    const gRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let match;
    while ((match = gRegex.exec(snippet)) !== null) {
      const val = match[1];
      const distance = Math.abs(match.index - centerOffset);
      if (distance < minDistance) {
        minDistance = distance;
        closestVal = val;
      }
    }
  }
  return closestVal;
}

/**
 * Google Play 检索 + 解析。
 * ⚠️ 依赖 Google 的混淆类名（vWM94c / DdYX5 / LbQbAe / bzqKMd），
 * 解析失败会被识别成 parser_failed（不再谎报 0 结果），但解析器本身没有自动修复能力，
 * 线上若真失效需要人工跟进类名。
 */
export async function searchGooglePlay(query, country = 'us') {
  try {
    const countryCode = (country || 'us').toLowerCase();
    // hl 必须是语言码，不能拿国家码代替 —— 见 MARKET_LANGUAGE 的注释。
    const langCode = googlePlayLang(countryCode);
    const url = `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&gl=${countryCode}&hl=${encodeURIComponent(langCode)}`;
    const res = await fetchWithRetry(url, {
      'User-Agent': UA,
      // 与 hl 保持一致：hl 非法时 Google 会改用 Accept-Language 猜测语言，
      // 写死中文头会让回退行为不可预测。
      'Accept-Language': `${langCode},en;q=0.8`,
    });
    if (!res.ok) return { apps: [], ok: false, reason: 'network_failed' };
    const html = await res.text();

    // 与混淆类名无关的独立信号：页面里究竟有没有应用详情链接。
    // 有链接却一个都解析不出来 → 判定解析器失效，而非「无结果」。
    const linkCount = (html.match(/href="\/store\/apps\/details\?id=/g) || []).length;

    const appsMap = {};
    const regex = /href="\/store\/apps\/details\?id=([a-zA-Z0-9_.]+)"/g;
    let match;
    /** 走兜底解析的卡片数。> 0 说明混淆类名已失效，需要人工更新主路径的类名 */
    let fallbackParsed = 0;

    while ((match = regex.exec(html)) !== null) {
      const packageId = match[1];
      const startIdx = match.index;

      // 把片段居中到匹配的 href 附近，避免串到相邻应用
      const snippetStart = Math.max(0, startIdx - 1000);
      const snippetEnd = Math.min(html.length, startIdx + 1500);
      const snippet = html.substring(snippetStart, snippetEnd);
      const centerOffset = startIdx - snippetStart;

      let name = getClosestRegexMatch(
        snippet,
        [
          /<div[^>]*class="[^"]*vWM94c[^"]*"[^>]*>([^<]+)<\/div>/,
          /<span[^>]*class="[^"]*DdYX5[^"]*"[^>]*>([^<]+)<\/span>/,
        ],
        centerOffset
      );

      if (name) {
        name = name.replace(/^播放《/, '').replace(/》$/, '').replace(/&amp;/g, '&').trim();
      }

      // 主路径取不到名称，或取到的是评价数/截图说明这类辅助文案 → 走与类名无关的兜底
      const nameUnusable =
        !name || name.includes('获评') || name.includes('Rated') ||
        name.includes('屏幕') || name.includes('图标') || name.includes('详细');
      let usedFallback = false;
      if (nameUnusable) {
        const fb = parseCardTextFallback(snippet);
        if (fb.name) {
          name = fb.name;
          fallbackParsed += 1;
          usedFallback = true;
        } else {
          continue;
        }
      }

      let developer = getClosestRegexMatch(
        snippet,
        [
          /<div[^>]*class="[^"]*LbQbAe[^"]*"[^>]*>([^<]+)<\/div>/,
          /<span[^>]*class="[^"]*wMUdtb[^"]*"[^>]*>([^<]+)<\/span>/,
        ],
        centerOffset
      );
      if (developer) developer = developer.replace(/&amp;/g, '&').trim();

      // 走了兜底说明主路径类名已失效，开发者一并从同一份卡片文本里取（texts[1]）
      if (usedFallback && !developer) {
        developer = parseCardTextFallback(snippet).developer;
      }

      const iconUrl = getClosestRegexMatch(
        snippet,
        [
          /<img[^>]+src="([^"]+)"[^>]+class="[^"]*bzqKMd[^"]*"/,
          /<img[^>]+src="([^"]+)"[^>]+class="[^"]*stzEZd[^"]*"/,
          /(https:\/\/play-lh\.googleusercontent\.com\/[a-zA-Z0-9_\-=]+)/,
        ],
        centerOffset
      );

      let rating;
      const ratingStr = getClosestRegexMatch(
        snippet,
        [/<div[^>]*class="[^"]*i3Ym6e[^"]*"[^>]*>([\d.]+)</, /获评\s*([\d.]+)\s*颗星/],
        centerOffset
      );
      if (ratingStr) rating = parseFloat(ratingStr);

      if (!appsMap[packageId]) {
        appsMap[packageId] = {
          name,
          developer: developer || '未知开发者',
          // 不写 category：Google Play 页面未返回真实类目，把入参或默认值写进去等于伪造数据。
          rating,
          iconUrl: iconUrl || '',
          url: `https://play.google.com/store/apps/details?id=${packageId}`,
          bundleId: packageId,
          matchType: 'Google Play Match',
        };
      } else {
        const existing = appsMap[packageId];
        if (name && (!existing.name || existing.name.length < name.length)) existing.name = name;
        if (developer && developer !== '未知开发者' && (!existing.developer || existing.developer === '未知开发者')) {
          existing.developer = developer;
        }
        if (iconUrl && !existing.iconUrl) existing.iconUrl = iconUrl;
        if (rating && !existing.rating) existing.rating = rating;
      }
    }

    const apps = Object.values(appsMap);
    if (apps.length === 0 && linkCount > 0) {
      return { apps: [], ok: false, reason: 'parser_failed' };
    }
    if (fallbackParsed > 0) {
      console.warn(
        `[GooglePlay] 主解析路径类名疑似失效，${fallbackParsed}/${apps.length} 张卡片走了兜底解析，结果可能不完整（解析类名需更新）。`
      );
    }
    return { apps, ok: true };
  } catch (err) {
    return { apps: [], ok: false, reason: 'network_failed', error: String(err?.message || err) };
  }
}

/** Apple App Store 检索（iTunes Search API） */
export async function searchAppStore(query, country = 'us') {
  try {
    const countryCode = (country || 'us').toLowerCase();
    // limit 取 200 = iTunes Search API 的上限（实测 limit=300 也只回 192 条）。
    // ⚠️ 不要为了省流量调小：SKILL.md 与判定规则都对用户承诺「返回完整结果清单、不截断」；
    // 且 iTunes 默认排序不保证完全同名在前，只取前若干条会漏掉真正的同名命中（假阴性）。
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&country=${countryCode}&limit=200`;
    const res = await fetchWithRetry(itunesUrl, {
      'User-Agent': 'AppAuditScanner/2.0',
    });

    if (!res.ok) return { apps: [], ok: false, reason: 'network_failed' };

    const data = await res.json();
    if (!data.results || !Array.isArray(data.results)) {
      return { apps: [], ok: false, reason: 'parser_failed' };
    }

    const apps = data.results.map((item) => ({
      name: item.trackName || '未命名应用',
      developer: item.artistName || '未知开发者',
      // iTunes 返回真实类目 primaryGenreName；取不到时不填具体类目。
      category: item.primaryGenreName || '应用',
      rating: item.averageUserRating ? Math.round(item.averageUserRating * 10) / 10 : undefined,
      ratingCount: item.userRatingCount,
      iconUrl: item.artworkUrl100 || item.artworkUrl60 || item.artworkUrl512,
      url: item.trackViewUrl,
      bundleId: item.bundleId,
      matchType: 'Similar Keyword',
      country: countryCode.toUpperCase(),
    }));

    // results: [] 属「检索完成但确实没有」，ok 仍为 true
    return { apps, ok: true };
  } catch (err) {
    return { apps: [], ok: false, reason: 'network_failed', error: String(err?.message || err) };
  }
}

/**
 * 统一检索入口：按「平台 + 单个市场」取数，并完成 matchType 判定与相关性过滤。
 *
 * ⚠️ 市场是**必填**的。商店检索结果分市场返回（Apple 走 `country=xx` 店铺、
 * Google 走 `gl=xx`），同一名称在不同市场的占用情况可以完全不同 ——
 * 替调用方默认一个市场，等于把「某个市场的结论」冒充成「用户目标市场的结论」。
 * 要查多个市场就调用多次（每个市场一次），不要把市场并成一个。
 *
 * 前缀命中门槛：名称 < 4 字符时不计前缀命中，落到 Contains Match（仅展示、不升级风险）。
 * 超短名（AI / X / Go）几乎必然有一堆同前缀应用，计入会让占用风险失去区分度。
 */
export async function scanStore({ name, platform = 'apple', market, country }) {
  // market 为首选参数；country 仅为兼容旧调用保留
  const marketCode = String(market || country || '').trim().toLowerCase();
  if (!marketCode) {
    throw new Error('scanStore 缺少目标市场：必须显式传入 market（如 market: "us"）。商店检索结果分市场返回，不存在默认市场。');
  }

  const lowerName = name.toLowerCase();
  const cleanInput = lowerName.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  const prefixEligible = Array.from(name).length >= 4;

  const storeScan =
    platform === 'google'
      ? await searchGooglePlay(name, marketCode)
      : await searchAppStore(name, marketCode);

  let hasExactMatch = false;
  let hasPrefixMatch = false;

  const rawMatches = storeScan.apps.map((item) => {
    const trackLower = (item.name || '').toLowerCase();
    const cleanTrack = trackLower.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');

    let matchType = 'Similar Keyword';
    if (trackLower === lowerName || cleanTrack === cleanInput) {
      matchType = 'Exact Match';
      hasExactMatch = true;
    } else if (prefixEligible && (trackLower.startsWith(lowerName) || cleanTrack.startsWith(cleanInput))) {
      matchType = 'Prefix Match';
      hasPrefixMatch = true;
    } else if (trackLower.includes(lowerName) || cleanTrack.includes(cleanInput)) {
      matchType = 'Contains Match';
    }

    // country 一律写真实市场码：请求本身带 gl=xx，结果就是该店铺的检索结果，
    // 标成 GLOBAL 会让多市场结果无法区分。
    return { ...item, matchType, country: marketCode.toUpperCase(), market: marketCode.toUpperCase() };
  });

  // 过滤掉完全无关的竞品结果（Apple 的模糊搜索尤其严重）
  const liveStoreMatches = rawMatches.filter((m) =>
    m.matchType !== 'Similar Keyword' ? true : isRelevant(name, m.name)
  );

  return {
    market: marketCode.toUpperCase(),
    // ok / reason 必须透到顶层：调用方（engine 的 marketScans）只看这两个字段判断
    // 该市场是否真的检索完成。只放在 storeScan 里会让上层误判为「全部失败」。
    ok: storeScan.ok,
    reason: storeScan.reason,
    storeScan,
    liveStoreMatches,
    hasExactMatch,
    hasPrefixMatch,
  };
}
