/**
 * 应用名称合规判定引擎
 *
 * 脚本只负责「可确定性判定」的部分：
 *   1. 字符长度审计（30 字符上限）
 *   2. 促销 / 排名 / 官方暗示 / 误导性 违禁词（独立词 + 内嵌连写两档）
 *   3. 无意义占位名 / 键盘乱敲检测
 *   4. Emoji 与非标符号
 *   5. 名称占用（商店同名 / 前缀相近 / 相关结果）
 *   6. 平台裁决（appleVerdict / googleVerdict）与提审阻断项（overallStatus / blockers）
 *
 * ⚠️ **品牌与商标维度不由脚本判定**，一律移交调用方模型完成 —— 见下面「品牌 / 商标判定」一节。
 *
 * 判定口径的来龙去脉见 ../references/判定规则.md，改引擎前先读它。
 */

// ===========================================================================
// 通用工具
// ===========================================================================

// 字素簇切分器只建一次：每次调用都 new 一个在批量筛查时开销明显
let GRAPHEME_SEGMENTER = null;
function graphemeSegmenter() {
  if (GRAPHEME_SEGMENTER === null) {
    try {
      GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      GRAPHEME_SEGMENTER = false; // 环境不支持时回退码点计数
    }
  }
  return GRAPHEME_SEGMENTER || null;
}

/**
 * 字符计数：按「用户看到的一个字符」= 字素簇计数，与 04 项 Emoji 判定同一口径。
 *
 * 不按码点计：👨‍👩‍👧 是 5 个码点（3 个 emoji + 2 个 ZWJ）但只显示为 1 个字符，
 * 04 项按字素簇算「1 个 emoji」，01 项若按码点算 5 字符，同一串名字在一份报告里
 * 会出现两套计数。é 也有同样问题（e + 组合符 = 2 码点 / 1 字素）。
 */
export const charLen = (s) => {
  if (!s) return 0;
  const seg = graphemeSegmenter();
  if (!seg) return Array.from(s).length;
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
};

/** 输入名称长度上限：商店标题字段本身只有 30 字符，超过 60 已不可能是真实应用名 */
export const NAME_INPUT_MAX = 60;

// ===========================================================================
// 品牌 / 商标判定：整块移交调用方模型
//
// 脚本不内置品牌词表、不做品牌形态匹配、也不产出任何品牌结论。
// 静态词表覆盖极窄，名称未命中会被读成「无商标风险」—— 那是比不查更坏的假阴性，
// 因为用户会信。品牌识别（形近 / 内嵌 / 同形替换 / 跨语言别名 / 品类内知名产品名 /
// 在先商标）由调用方模型用自己的品牌知识完成，脚本只输出素材与判定契约
// （口径见 references/判定规则.md A 节）。
// ===========================================================================

/** 四档冲突形态 —— 模型判定时按此口径归类，形态标签与 A.3 节保持一致 */
export const BRAND_FORM_LABEL = {
  exact: '独立使用',
  homoglyph: '同形字符替换',
  embedded: '品牌词内嵌/连写',
  typo: '形近变体',
};

/**
 * 从名称中切出候选品牌词，供模型逐个对照自己的品牌知识。
 * 含：按分隔符切出的词、驼峰分段、中文连续串的 2/3 字滑窗。
 * 这些只是「可能的检查对象」，不是命中结果。
 */
export function extractNameTokens(rawName) {
  const out = new Set();
  const push = (t) => {
    const s = String(t ?? '').trim();
    if (s.length >= 2) out.add(s);
  };
  const segments = String(rawName ?? '').split(/[^A-Za-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  for (const seg of segments) {
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      // 中文：整段 + 2/3 字滑窗（微信助手 → 微信助手 / 微信 / 信助 / 助手 / 微信助 / 信助手）
      push(seg);
      for (let i = 0; i < seg.length; i++) {
        push(seg.slice(i, i + 2));
        if (i + 3 <= seg.length) push(seg.slice(i, i + 3));
      }
    } else {
      push(seg);
      // 驼峰分段：FreeChat → Free / Chat
      for (const part of seg.split(/(?=[A-Z])/)) push(part);
    }
  }
  return Array.from(out);
}

/** 模型完成 05 项时必须遵守的契约 */
export const BRAND_REVIEW_CONTRACT = {
  // 字段名（riskLevel / collisions / rationale / alternatives）是回填用的机器可读键，
  // **不写进交付**；等级值一律用中文 —— 报告是给中文用户看的，英文枚举会被模型原样抄出去。
  requiredFields: ['riskLevel', 'collisions', 'rationale', 'alternatives'],
  riskLevels: {
    高: '直接使用他人品牌，或同形替换等主动伪装手法（如 spot1fy / app1e）',
    中: '形近变体或内嵌连写，存在混淆风险（如 spotifyy / myuberapp）',
    低: '与已知品牌无可归因的相似',
  },
  collisionForms: BRAND_FORM_LABEL,
  mustCheck: [
    '知名品牌，含跨语言别名（微信 / wechat、抖音 / tiktok）',
    '品类内头部产品名（未必注册为商标，但同属混淆风险）',
    '形近变体与同形字符替换（spot1fy / app1e / g00gle）',
    '内嵌连写（myuberapp / FreeChat 这类形态）',
    '名称中作为通用词出现但恰好与他人在先品牌同形的词（Apple Pie 里的 apple 属此类，需说明为何不构成冲突）',
  ],
  forbiddenClaims: [
    '已按尼斯类别完成商标检索',
    '已接入或已查询 USPTO / CNIPA / WIPO 数据库',
    '该名称无商标风险',
  ],
};

/** 构造「移交模型」的品牌判定任务包 */
export function buildBrandReview(rawName) {
  return {
    delegated: true,
    handledByScript: false,
    targets: extractNameTokens(rawName),
    contract: BRAND_REVIEW_CONTRACT,
  };
}

/** 需核查的尼斯类别（指引，非逐类别判定） */
export const TRADEMARK_CLASS_SCOPE = [
  { code: 9, label: '可下载软件', applicability: '应用形态分发的产品必然落入此类，需核查。' },
  { code: 42, label: 'SaaS 软件服务', applicability: '仅在产品提供线上服务（账号、云端功能、订阅等）时适用。' },
];

/** 官方商标核查渠道 */
export const TRADEMARK_VERIFICATION_CHANNELS = [
  { name: 'USPTO 商标检索（美国）', url: 'https://tmsearch.uspto.gov/' },
  { name: 'WIPO Global Brand Database（全球品牌库）', url: 'https://branddb.wipo.int/' },
  { name: '中国商标网 CNIPA', url: 'https://sbj.cnipa.gov.cn/sbj/index.html' },
];

// ===========================================================================
// 促销 / 排名 / 官方暗示 / 误导性 违禁词（词库对齐 Apple 2.3.7 与 Google 元数据政策原文）
// ===========================================================================

const PROMO_LEXICON = [
  // ── 价格与促销信息（pricing / promotional information）：两家都明文禁止 ──
  // free 保持阻断：它是两家政策明文点名的定价信息，而常见复合词（Freeform / Freedom /
  // Freelancer / Freestyle / Freemium …）已由 PROMO_SAFE_COMPOUNDS 排除，不会误伤专名。
  { word: 'free', category: 'price', strength: 'blocking' },
  { word: 'no ads', category: 'price', strength: 'blocking' },
  { word: 'ad-free', category: 'price', strength: 'blocking' },
  { word: 'discount', category: 'price', strength: 'blocking' },
  { word: 'sale', category: 'price', strength: 'review' },
  { word: 'cheap', category: 'price', strength: 'review' },
  { word: 'limited time', category: 'price', strength: 'blocking' },
  { word: 'freebie', category: 'price', strength: 'blocking' },
  { word: 'free trial', category: 'price', strength: 'blocking' },
  // Google 点名的是「無廣告 / No Ads」，连写形态 NoAds / adfree 同样要抓
  { word: 'noads', category: 'price', strength: 'blocking' },
  { word: 'adfree', category: 'price', strength: 'blocking' },
  { word: 'discounted', category: 'price', strength: 'blocking' },
  { word: 'discounts', category: 'price', strength: 'blocking' },
  { word: '免费', category: 'price', strength: 'blocking' },
  { word: '无广告', category: 'price', strength: 'blocking' },
  { word: '限时免费', category: 'price', strength: 'blocking' },
  { word: '免费下载', category: 'price', strength: 'blocking' },
  { word: '折扣', category: 'price', strength: 'blocking' },
  { word: '优惠', category: 'price', strength: 'blocking' },
  { word: '促销', category: 'price', strength: 'blocking' },
  { word: '特价', category: 'price', strength: 'blocking' },
  { word: '返现', category: 'price', strength: 'blocking' },
  { word: '现金回馈', category: 'price', strength: 'blocking' },
  { word: '半价', category: 'price', strength: 'blocking' },
  { word: '立减', category: 'price', strength: 'blocking' },
  { word: '100%', category: 'price', strength: 'review' },

  // ── 商店表现与排名（store performance / ranking）＋无法验证的宣称 ──
  { word: 'best', category: 'ranking', strength: 'review' },
  { word: 'top', category: 'ranking', strength: 'review' },
  { word: 'no.1', category: 'ranking', strength: 'blocking' },
  { word: 'no 1', category: 'ranking', strength: 'blocking' },
  { word: '#1', category: 'ranking', strength: 'blocking' },
  { word: 'number one', category: 'ranking', strength: 'blocking' },
  { word: 'ranked', category: 'ranking', strength: 'blocking' },
  { word: 'ranking', category: 'ranking', strength: 'blocking' },
  { word: 'award', category: 'ranking', strength: 'blocking' },
  { word: 'awards', category: 'ranking', strength: 'blocking' },
  { word: 'award-winning', category: 'ranking', strength: 'blocking' },
  { word: 'popular', category: 'ranking', strength: 'blocking' },
  { word: 'trending', category: 'ranking', strength: 'blocking' },
  { word: "world's best", category: 'ranking', strength: 'blocking' },
  { word: 'ultimate', category: 'ranking', strength: 'blocking' },
  { word: '最好', category: 'ranking', strength: 'review' },
  { word: '最强', category: 'ranking', strength: 'blocking' },
  { word: '最佳', category: 'ranking', strength: 'review' },
  { word: '第一', category: 'ranking', strength: 'review' },
  { word: '排名', category: 'ranking', strength: 'blocking' },
  { word: '榜首', category: 'ranking', strength: 'blocking' },
  { word: '年度应用', category: 'ranking', strength: 'blocking' },
  { word: '年度最佳', category: 'ranking', strength: 'blocking' },
  { word: '热门', category: 'ranking', strength: 'blocking' },
  { word: '爆款', category: 'ranking', strength: 'blocking' },
  { word: '获奖', category: 'ranking', strength: 'blocking' },
  { word: '得奖', category: 'ranking', strength: 'blocking' },

  // ── 暗示与官方 / Google Play 计划的关系（affiliation）──
  { word: 'official', category: 'affiliation', strength: 'blocking' },
  { word: "editor's choice", category: 'affiliation', strength: 'blocking' },
  { word: 'google play', category: 'affiliation', strength: 'blocking' },
  { word: 'play pass', category: 'affiliation', strength: 'blocking' },
  { word: 'top pick', category: 'affiliation', strength: 'blocking' },
  { word: '官方', category: 'affiliation', strength: 'blocking' },
  { word: '编辑精选', category: 'affiliation', strength: 'blocking' },
  { word: '新上架', category: 'affiliation', strength: 'blocking' },

  // ── 误导性 / 违规功能宣称（misleading）──
  { word: 'cheat', category: 'misleading', strength: 'review' },
  { word: 'cheats', category: 'misleading', strength: 'review' },
  { word: 'hack', category: 'misleading', strength: 'review' },
  { word: 'unlimited money', category: 'misleading', strength: 'blocking' },
  { word: 'download now', category: 'misleading', strength: 'blocking' },
  { word: 'install now', category: 'misleading', strength: 'blocking' },
  { word: '破解', category: 'misleading', strength: 'blocking' },
  { word: '修改版', category: 'misleading', strength: 'blocking' },
  { word: '无限金币', category: 'misleading', strength: 'blocking' },
  { word: '立即下载', category: 'misleading', strength: 'blocking' },
  { word: '马上安装', category: 'misleading', strength: 'blocking' },
  { word: '点击下载', category: 'misleading', strength: 'blocking' },
];

/** 词条分类的中文标签与展示顺序 */
export const PROMO_CATEGORY_LABEL = {
  price: '价格与促销',
  ranking: '排名与表现宣称',
  affiliation: '官方/计划暗示',
  misleading: '误导性宣称',
};
export const PROMO_CATEGORY_ORDER = ['price', 'ranking', 'affiliation', 'misleading'];

// 纯 ASCII 词条（字母/数字/空格）才适用 \b 词边界；含 # % 或中文的走各自的匹配分支
const PROMO_ASCII = /^[a-z0-9 ]+$/;

const PROMO_ASCII_WORDS = new Set(
  PROMO_LEXICON.filter((e) => PROMO_ASCII.test(e.word)).map((e) => e.word)
);

// 词典词 / 已注册品牌词豁免：只作用于「内嵌连写」通路的防误报
// （laptop 里的 top、bestow 里的 best、freelance 里的 free 都不该算促销词）
const PROMO_SAFE_COMPOUNDS = [
  'freecash', 'freeform', 'freedom', 'freelancer', 'freelance', 'freeplus', 'carefree',
  'freestyle', 'freemium', 'freehand', 'freeway', 'freesia',
  'bestow', 'bestie', 'bestseller',
  'topgolf', 'laptop', 'desktop', 'stopwatch',
  'priceline', 'cashapp', 'cashback',
  'wholesale', 'resale', 'presale', 'salesforce', 'salesman', 'salesperson',
];

// 独立词匹配（Free Chat / Best Notes）：\b 词边界，避免 coffee 命中 free、laptop 命中 top
function matchPromoEntry(text, word) {
  if (PROMO_ASCII.test(word)) {
    return new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text);
  }
  if (word.startsWith('#')) {
    // \b 对 # 不生效，改用「前面不是字母数字、后面不是数字」的边界
    return new RegExp(`(^|[^a-z0-9])${word}(?![0-9])`, 'i').test(text);
  }
  return text.toLowerCase().includes(word.toLowerCase());
}

const promoCategoryOf = (word) =>
  PROMO_LEXICON.find((e) => e.word === word)?.category ?? 'price';

/** 独立词命中：官方条款直接覆盖的形态 */
export function checkBannedWords(text) {
  if (!text) return [];
  const found = [];
  for (const entry of PROMO_LEXICON) {
    if (!found.includes(entry.word) && matchPromoEntry(text, entry.word)) found.push(entry.word);
  }
  return found;
}

/**
 * 内嵌 / 连写命中（FreeChat、freechat、ChatFree）：\b 词边界抓不到，
 * 但按官方原文的语义口径（“不得包含…价格或促销信息” / Google 点名「免費」不得出现在应用名称中）
 * 同样落入禁用范围，因此与独立词同级，只区分形态。
 */
export function checkEmbeddedPromoWords(text) {
  if (!text) return [];
  const found = new Set();
  const segments = text.split(/[^A-Za-z0-9]+/).filter(Boolean);

  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    const hits = [];

    // 1) 驼峰分段：FreeChat -> free | chat
    const camelParts = /[a-z]/.test(seg) ? seg.split(/(?=[A-Z])/) : [];
    if (camelParts.length > 1) {
      let offset = 0;
      for (const part of camelParts) {
        const partLower = part.toLowerCase();
        if (PROMO_ASCII_WORDS.has(partLower)) {
          hits.push({ word: partLower, start: offset, end: offset + part.length });
        }
        offset += part.length;
      }
    } else {
      // 2) 全小写 / 全大写连写：freechat / chatfree（剩余部分需 ≥3 字符，避开 bestow 这类短尾）
      for (const word of PROMO_ASCII_WORDS) {
        if (word.includes(' ') || segLower === word) continue;
        if (segLower.length - word.length < 3) continue;
        if (segLower.startsWith(word)) hits.push({ word, start: 0, end: word.length });
        else if (segLower.endsWith(word)) hits.push({ word, start: segLower.length - word.length, end: segLower.length });
      }
    }

    // 3) 整段即词条：抓「官方点名短语」的连写形态（no ads -> NoAds / noads）
    if (PROMO_ASCII_WORDS.has(segLower)) {
      hits.push({ word: segLower, start: 0, end: segLower.length });
    }

    // 只有「整个命中区段」都被合法复合词覆盖时才豁免
    for (const hit of hits) {
      const shielded = PROMO_SAFE_COMPOUNDS.some((safe) => {
        let idx = segLower.indexOf(safe);
        while (idx !== -1) {
          if (idx <= hit.start && idx + safe.length >= hit.end) return true;
          idx = segLower.indexOf(safe, idx + 1);
        }
        return false;
      });
      if (!shielded) found.add(hit.word);
    }
  }

  return Array.from(found);
}

/** 汇总两类命中，并带上官方分类与形态，供报告按政策类别展示 */
/** 查词条的阻断强度。查不到时按 blocking 处理（新词条默认从严，不静默放过） */
export function promoStrengthOf(word) {
  return PROMO_LEXICON.find((e) => e.word === word)?.strength ?? 'blocking';
}

export function buildPromoFindings(standalone, embedded) {
  return [
    ...standalone.map((word) => ({
      word,
      category: promoCategoryOf(word),
      strength: promoStrengthOf(word),
      form: 'standalone',
    })),
    ...embedded.map((word) => ({
      word,
      category: promoCategoryOf(word),
      strength: promoStrengthOf(word),
      form: 'embedded',
    })),
  ];
}

// ===========================================================================
// 占位名 / 键盘乱敲检测
// ===========================================================================

/** 检测无效占位名、纯数字、键盘乱敲或重复字符块（如 AAAEEECCC、111、asdf） */
export function checkPlaceholderOrGibberish(text, fieldName) {
  if (!text) return { isBad: false, reason: '' };
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. 纯数字 e.g. "111", "123", "2026"
  if (/^\d+$/.test(trimmed)) {
    return {
      isBad: true,
      reason: `在【${fieldName}】中使用了纯数字“${trimmed}”，缺乏实际品牌或功能含义，属于无效占位文本。`,
    };
  }

  // 2. 单字重复或重复块 e.g. "AAA", "BBB", "AAAEEECCC", "111111"
  if (trimmed.length <= 60 && (/^([a-zA-Z0-9])\1+$/.test(trimmed) || /^([a-zA-Z0-9]{2,4})\1{2,}$/i.test(trimmed))) {
    return {
      isBad: true,
      reason: `在【${fieldName}】中检测到单字或字符块重复模式（如“${trimmed}”），属于无意义占位打字。`,
    };
  }

  // 3. 连续 3 个以上字母块重复 e.g. "AAAEEECCC"
  if (trimmed.length <= 60 && /([a-zA-Z])\1{2,}([a-zA-Z])\2{2,}/i.test(trimmed)) {
    return {
      isBad: true,
      reason: `在【${fieldName}】中检测到连续字母块重复（如“${trimmed}”），属于无意义测试字符。`,
    };
  }

  // 4. 键盘乱敲 / 测试占位词。必须用严格词边界，否则 "fastest" 会命中 "test"
  const placeholders = ['asdf', 'qwerty', 'zxcv', 'placeholder', '123456', 'abcde'];
  for (const ph of placeholders) {
    if (new RegExp(`\\b${ph}\\b`, 'i').test(lower)) {
      return { isBad: true, reason: `在【${fieldName}】中检测到常见测试占位词“${ph}”。` };
    }
  }

  // 5. 短输入（≤50 字符）里的独立 "test" / "demo"
  if (trimmed.length <= 50) {
    for (const ph of ['test', 'demo']) {
      if (new RegExp(`\\b${ph}\\b`, 'i').test(lower)) {
        return { isBad: true, reason: `在【${fieldName}】中检测到测试/演示占位词“${ph}”。` };
      }
    }
  }

  return { isBad: false, reason: '' };
}

// ===========================================================================
// Emoji / 非标符号检测
//
// 覆盖范围必须与报告文案声称的一致 —— 文案说检了 ★，正则就必须抓得到 ★：
//   · \p{Extended_Pictographic}  Emoji 表情（🚀 ⭐ 🍎）
//   · \u2600-\u26FF              Miscellaneous Symbols，含 ★ ☆ ♥ ☀
//   · \u2700-\u27BF              Dingbats
//   · \u2B00-\u2BFF              Misc Symbols and Arrows
//   · \u20E3                     组合用包围键帽标记（1️⃣ 的第三段）
//   · \uFE0F                     变体选择符（❤️ 的第二段）
//
// 用 Intl.Segmenter 按「字素簇」切分，把 1️⃣ / ❤️ / 👨‍👩‍👧 这类多码点组合整体取回，
// 避免只抓到半个字符。环境不支持 Segmenter 时退化为逐码点。
// 注意：用 /u 而非 /gu —— 该正则会被反复 test()，带 g 会因 lastIndex 残留而漏判。
// ===========================================================================

const EMOJI_CHAR = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u2600-\u27BF\u2B00-\u2BFF\u20E3\uFE0F]/u;

export function findEmojiAndSymbols(text) {
  const out = [];
  const seen = new Set();
  let segments;
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    segments = Array.from(seg.segment(text), (s) => s.segment);
  } catch {
    segments = Array.from(text);
  }
  for (const s of segments) {
    if (EMOJI_CHAR.test(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ===========================================================================
// 检索结果相关性过滤
// ===========================================================================

/**
 * 汉字繁→简对照表（成对排列，每两个字符一组：前者繁体、后者简体）。
 *
 * 来源：OpenCC 的 TSCharacters.txt（繁→简单字词典），只保留单字对单字。
 * 取「繁→简」而非「简→繁」：前者是多对一，「曆 / 歷 → 历」这类一字多形都能收敛到同一个字；
 * 后者是一对多，取第一候选会把「日历」转成「日歷」，反而对不上港台店里的「日曆」。
 * 这份表一律由权威词典生成，不要手改 —— 手写极易把形近的简繁字（络/絡、频/頻）录成同一个字。
 *
 * 用途：商店结果里的名称是店铺语言下的写法 —— 中国香港 / 中国台湾店里是「計算機」「日曆」，
 * 用简体名去查时一字不重合，会被 isRelevant 整条过滤掉，报告最后说「未检索到同名」，
 * 属假阴性。归一化只在原文判定不中时兜底，只增不减。
 */
const HAN_VARIANT_PAIRS =
  '丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦偉伟側侧偵侦偽伪傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪' +
  '僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿優优儲储儷俪儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲劃划劄札' +
  '劇剧劉刘劊刽劌刿劍剑劑剂勁劲動动務务勛勋勝胜勞劳勢势勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员唄呗唸念問问啓启啞哑啟启啢唡喚唤' +
  '喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗶哔嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘮唠嘯啸嘰叽嘵哓嘸呒嘽啴噁恶噓嘘噝咝噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚥咽嚦呖嚨咙嚮向嚲亸嚳喾嚴严' +
  '嚶嘤囀啭囁嗫囂嚣囅冁囈呓囉啰囌苏囑嘱囪囱圇囵國国圍围園园圓圆圖图團团垻坝埡垭埰采執执堅坚堊垩堖垴堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塹堑墊垫墜坠墮堕墰坛墳坟墶垯墻墙墾垦壇坛壋垱壎埙壓压' +
  '壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娛娱婁娄婦妇婭娅媧娲媯妫媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬈娆嬋婵嬌娇嬙嫱嬡嫒嬤嬷' +
  '嬪嫔嬰婴嬸婶孃娘孌娈孫孙學学孿孪宮宫寀采寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嶁嵝嶄崭嶇岖嶔嵚嶗崂' +
  '嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶺岭嶼屿嶽岳巋岿巒峦巔巅巖岩巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幗帼幘帻幟帜幣币幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廟庙廠厂廡庑廢废廣广廩廪廬庐廳厅弒弑弔吊弳弪' +
  '張张強强彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆' +
  '慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憤愤憫悯憮怃憲宪憶忆懇恳應应懌怿懍懔懞蒙懟怼懣懑懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡' +
  '掗挜掙挣掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搧扇搵揾搶抢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撏挦撐撑撓挠撟挢撣掸撥拨撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擔担據据擠挤擡抬擣捣擬拟擯摈擰拧擱搁' +
  '擲掷擴扩擷撷擺摆擻擞擼撸擾扰攄摅攆撵攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斆敩斕斓斬斩斷断於于旂旗旣既昇升時时晉晋晝昼暈晕暉晖暘旸暢畅暫暂曄晔曆历曇昙曉晓曏向' +
  '曖暧曠旷曨昽曬晒書书會会朧胧朮术東东枴拐柵栅柺拐査查桿杆梔栀梘枧條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棧栈棲栖棶梾椏桠楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槮椮槳桨槶椢槼椝樁桩' +
  '樂乐樅枞樑梁樓楼標标樞枢樣样樧榝樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横檁檩檉柽檔档檜桧檟槚檢检檣樯檮梼檯台檳槟檸柠檻槛櫃柜櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉權权' +
  '欏椤欒栾欖榄欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殤殇殫殚殭僵殮殓殯殡殲歼殺杀殻壳殼壳毀毁毆殴毿毵氂牦氈毡氌氇氣气氫氢氬氩氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃涇泾涗涚涼凉淒凄淚泪' +
  '淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湞浈湧涌湯汤溈沩準准溝沟溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁' +
  '潙沩潛潜潤润潯浔潰溃潷滗潿涠澀涩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澮浍澱淀濁浊濃浓濕湿濘泞濚溁濛蒙濜浕濟济濤涛濫滥濰潍濱滨濺溅濼泺濾滤瀂澛瀅滢瀆渎瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜' +
  '灃沣灄滠灑洒灕漓灘滩灝灏灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煉炼煒炜煙烟煢茕煥焕煩烦煬炀熅煴熒荧熗炝熱热熲颎熾炽燁烨燈灯燉炖燒烧燙烫燜焖營营燦灿燬毁燭烛燴烩燻熏燼烬燾焘爍烁爐炉爛烂爭争爲为爺爷爾尔牀床' +
  '牆墙牘牍牴抵牽牵犖荦犛牦犢犊犧牺狀状狹狭狽狈猙狰猶犹猻狲獁犸獃呆獄狱獅狮獎奖獨独獪狯獫猃獮狝獰狞獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱璉琏璡琎璣玑璦瑷璫珰環环璵玙' +
  '璸瑸璽玺璿璇瓊琼瓏珑瓔璎瓚瓒甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当疇畴疊叠痙痉痠酸痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈' +
  '癱瘫癲癫發发皁皂皚皑皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盪荡眞真眥眦眾众睏困睜睁睞睐瞘眍瞞瞒瞶瞆瞼睑矇蒙矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碩硕碭砀碸砜確确碼码磑硙磚砖磠硵磣碜磧碛磯矶磽硗礄硚礎础' +
  '礙碍礦矿礪砺礫砾礬矾礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稜棱稟禀種种稱称穀谷穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竪竖競竞筆笔' +
  '筍笋筧笕箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篠筿篤笃篩筛篳筚簀箦簍篓簑蓑簞箪簡简簣篑簫箫簹筜簽签簾帘籃篮籌筹籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糾纠紀纪' +
  '紂纣約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紡纺紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌終终絃弦組组絆绊絎绗結结絕绝絛绦絝绔絞绞絡络絢绚給给絨绒絰绖統统絲丝' +
  '絳绛絶绝絹绢綁绑綃绡綆绠綈绨綉绣綌绤綏绥綑捆經经綜综綞缍綠绿綢绸綣绻綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎締缔緡缗' +
  '緣缘緦缌編编緩缓緬缅緯纬緱缑緲缈練练緶缏緹缇緻致緼缊縈萦縉缙縊缢縋缒縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縭缡縮缩縱纵縲缧縴纤縵缦縶絷縷缕縹缥總总績绩繃绷繅缫繆缪繒缯織织繕缮繚缭繞绕繡绣繢缋繩绳' +
  '繪绘繫系繭茧繮缰繯缳繰缲繳缴繹绎繼继繽缤繾缱纇颣纈缬纊纩續续纍累纏缠纓缨纔才纖纤纘缵纜缆缽钵罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声' +
  '聳耸聵聩聶聂職职聹聍聽听聾聋肅肃脅胁脈脉脛胫脣唇脩修脫脱脹胀腎肾腖胨腡脶腦脑腫肿腳脚腸肠膃腽膕腘膚肤膠胶膩腻膽胆膾脍膿脓臉脸臍脐臏膑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舖铺舘馆艙舱艤舣艦舰' +
  '艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葤荮葦苇葯药葷荤蒐搜蒓莼蒔莳蒕蒀蒞莅蒼苍蓀荪蓆席蓋盖蓮莲蓯苁蓴莼蓽荜蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蕁荨蕆蒇蕎荞蕒荬蕓芸' +
  '蕕莸蕘荛蕢蒉蕩荡蕪芜蕭萧蕷蓣薀蕰薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薴苧薹苔薺荠藍蓝藎荩藝艺藥药藪薮藴蕴藶苈藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘢茏蘭兰蘺蓠蘿萝虆蔂處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕' +
  '蜆蚬蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螻蝼螿螀蟄蛰蟈蝈蟎螨蟣虮蟬蝉蟯蛲蟲虫蟶蛏蟻蚁蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠟蜡蠣蛎蠨蟏蠱蛊蠶蚕蠻蛮衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈' +
  '褘袆褲裤褳裢褸褛褻亵襇裥襉裥襏袯襖袄襝裣襠裆襤褴襪袜襬摆襯衬襲袭襴襕覈核見见覎觃規规覓觅視视覘觇覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覺觉覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訐讦訒讱訓训訕讪' +
  '訖讫託托記记訛讹訝讶訟讼訣诀訥讷訩讻訪访設设許许訴诉訶诃診诊註注証证詁诂詆诋詎讵詐诈詒诒詔诏評评詖诐詗诇詘诎詛诅詞词詠咏詡诩詢询詣诣試试詩诗詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詼诙詿诖誄诔誅诛誆诓誇夸' +
  '誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说説说誰谁課课誶谇誹诽誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅論论諗谂諛谀諜谍諝谞諞谝諡谥諢诨諤谔諦谛諧谐諫谏諭谕諮咨諱讳諳谙諶谌' +
  '諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謊谎謎谜謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謳讴謹谨謾谩譁哗證证譎谲譏讥譖谮識识譙谯譚谭譜谱譟噪譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉' +
  '變变讋詟讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豶豮貍狸貓猫貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅' +
  '資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賞赏賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賴赖賵赗賺赚賻赙購购賽赛賾赜贄贽贅赘贇赟贈赠贊赞贋赝贍赡贏赢贐赆贓赃贔赑贖赎贗赝贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹' +
  '踐践踰逾踴踊蹌跄蹕跸蹟迹蹠跖蹣蹒蹤踪蹺跷躂跶躉趸躊踌躋跻躍跃躑踯躒跞躓踬躕蹰躚跹躡蹑躥蹿躦躜躪躏軀躯車车軋轧軌轨軍军軑轪軒轩軔轫軛轭軟软軤轷軫轸軲轱軸轴軹轵軺轺軻轲軼轶軾轼較较輅辂輇辁輈辀載载輊轾輒辄' +
  '輓挽輔辅輕轻輛辆輜辎輝辉輞辋輟辍輥辊輦辇輩辈輪轮輬辌輯辑輳辏輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轉转轍辙轎轿轔辚轟轰轡辔轢轹轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥' +
  '遜逊遞递遠远遡溯適适遲迟遶绕遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄧邓鄭郑鄰邻鄲郸鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆' +
  '釔钇釕钌釗钊釘钉釙钋針针釣钓釤钐釦扣釧钏釩钒釵钗釷钍釹钕釺钎鈀钯鈁钫鈃钘鈄钭鈅钥鈈钚鈉钠鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈞钧鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈰铈鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉅巨鉆钻鉈铊' +
  '鉉铉鉋铇鉍铋鉑铂鉕钷鉗钳鉚铆鉛铅鉞钺鉢钵鉤钩鉦钲鉬钼鉭钽鉳锫鉶铏鉸铰鉺铒鉻铬鉿铪銀银銃铳銅铜銍铚銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銷销銹锈銻锑銼锉鋁铝鋃锒鋅锌鋇钡' +
  '鋌铤鋏铗鋒锋鋙铻鋝锊鋟锓鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋼钢錁锞錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錟锬錠锭錡锜錢钱錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎鍀锝' +
  '鍁锨鍃锪鍅钫鍆钔鍇锴鍈锳鍊炼鍋锅鍍镀鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎊镑鎌镰鎔镕鎖锁鎘镉鎚锤鎛镈鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎰镒鎲镋鎳镍鎵镓鎸镌鎿镎' +
  '鏃镞鏇旋鏈链鏌镆鏍镙鏐镠鏑镝鏗铿鏘锵鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏨錾鏰镚鏵铧鏷镤鏹镪鏽锈鐃铙鐋铴鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐦锎鐧锏鐨镄鐫镌鐮镰鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐿镱鑄铸鑊镬鑌镔鑑鉴鑒鉴鑔镲' +
  '鑕锧鑞镴鑠铄鑣镳鑥镥鑭镧鑰钥鑱镵鑲镶鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閎闳閏闰閑闲閒闲間间閔闵閘闸閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閶阊閹阉閻阎閼阏閽阍閾阈' +
  '閿阌闃阒闆板闇暗闈闱闊阔闋阕闌阑闍阇闐阗闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隕陨際际隨随險险隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难' +
  '雲云電电霑沾霢霡霧雾霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靨靥鞏巩鞝绱鞦秋鞽鞒韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韜韬韝鞲韞韫韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頎颀頏颃預预頑顽頒颁頓顿頗颇' +
  '領领頜颌頡颉頤颐頦颏頭头頮颒頰颊頲颋頴颕頷颔頸颈頹颓頻频頽颓顆颗題题額额顎颚顏颜顒颙顓颛顔颜願愿顙颡顛颠類类顢颟顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颱台颳刮颶飓颸飔颺飏颻飖颼飕飀飗飄飘' +
  '飆飙飈飚飛飞飠饣飢饥飣饤飥饦飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餕馂餖饾餘余餚肴餛馄餜馃餞饯餡馅館馆餬糊餱糇餳饧餵喂餶馉餷馇餺馎餼饩餾馏餿馊' +
  '饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饜餍饞馋饢馕馬马馭驭馮冯馱驮馳驰馴驯馹驲駁驳駐驻駑驽駒驹駔驵駕驾駘骀駙驸駛驶駝驼駟驷駡骂駢骈駭骇駰骃駱骆駸骎駿骏騁骋騂骍騅骓騌骔騍骒騎骑騏骐騖骛騙骗騤骙騫骞' +
  '騭骘騮骝騰腾騶驺騷骚騸骟騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驌骕驍骁驏骣驕骄驗验驚惊驛驿驟骤驢驴驤骧驥骥驦骦驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬚须鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽' +
  '魢鱾魨鲀魯鲁魴鲂魷鱿魺鲄鮁鲅鮃鲆鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮳鲓鮶鲪鮺鲝鯀鲧鯁鲠鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯰鲶鯴鲺鯷鳀' +
  '鯽鲫鯿鳊鰁鳈鰂鲗鰃鳂鰈鲽鰉鳇鰍鳅鰏鲾鰐鳄鰒鳆鰓鳃鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰥鳏鰨鳎鰩鳐鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰾鳔鱂鳉鱅鳙鱈鳕鱉鳖鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱝鲼鱟鲎鱠鲙鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱯鳠' +
  '鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鴆鸩鴇鸨鴉鸦鴒鸰鴕鸵鴛鸳鴝鸲鴞鸮鴟鸱鴣鸪鴦鸯鴨鸭鴯鸸鴰鸹鴴鸻鴻鸿鴿鸽鵂鸺鵃鸼鵐鹀鵑鹃鵒鹆鵓鹁鵜鹈鵝鹅鵠鹄鵡鹉鵪鹌鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶇鸫鶉鹑鶊鹒鶓鹋' +
  '鶖鹙鶘鹕鶚鹗鶡鹖鶥鹛鶩鹜鶬鸧鶯莺鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷊鹝鷓鹧鷖鹥鷗鸥鷙鸷鷚鹨鷥鸶鷦鹪鷫鹔鷯鹩鷲鹫鷳鹇鷴鹇鷸鹬鷹鹰鷺鹭鷽鸴鸇鹯鸌鹱鸏鹲鸕鸬鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐' +
  '麗丽麥麦麩麸麪面麫面麯曲麴曲麵面麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齪龊齬龉齲龋齶腭齷龌龍龙龎厐龐庞龔龚龕龛' +
  '龜龟';

/** 简→繁映射表（成对字符串解析而来，重复键以最后一次为准，无副作用） */
const HAN_VARIANT_MAP = (() => {
  const map = Object.create(null);
  for (let i = 0; i < HAN_VARIANT_PAIRS.length - 1; i += 2) {
    map[HAN_VARIANT_PAIRS[i]] = HAN_VARIANT_PAIRS[i + 1];
  }
  return map;
})();

/** 把文本里的繁体字统一成简体形态，供两侧比较前归一化使用。 */
export function normalizeHanVariants(text) {
  return String(text).replace(/[\u4e00-\u9fa5]/g, (ch) => HAN_VARIANT_MAP[ch] || ch);
}

/** 过滤掉商店模糊搜索返回的完全无关结果（如搜 ChagtGPT 返回 Google Gemini） */
export function isRelevant(query, appName) {
  const qRaw = query.toLowerCase().trim();
  const aRaw = appName.toLowerCase().trim();
  if (matchesPair(qRaw, aRaw)) return true;

  // 原文不中，再拿简繁归一化后的形态比一次：中国香港 / 中国台湾店铺里的名称是繁体写法，
  // 只比原文的话「计算器」永远匹配不到「計算機」，命中会被整条过滤掉。
  // 两段式（原文优先、归一化兜底）而非直接替换 —— 后者遇到不该转的字（如「公里」的里）
  // 会把原本能中的变成不中，反而制造新的漏检。
  const qNorm = normalizeHanVariants(qRaw);
  const aNorm = normalizeHanVariants(aRaw);
  if (qNorm === qRaw && aNorm === aRaw) return false;
  return matchesPair(qNorm, aNorm);
}

/** 一组（查询, 应用名）的相关性判定，比较前两侧已完成大小写与简繁处理。 */
function matchesPair(qLower, aLower) {
  if (aLower.includes(qLower) || qLower.includes(aLower)) return true;

  const qWords = qLower.split(/[^a-z0-9\u4e00-\u9fa5]/).filter((w) => w.length >= 2);
  const aWords = aLower.split(/[^a-z0-9\u4e00-\u9fa5]/).filter((w) => w.length >= 2);

  for (const qw of qWords) {
    for (const aw of aWords) {
      if (qw === aw || qw.includes(aw) || aw.includes(qw)) return true;
    }
  }

  // 单词语查询的模糊相似度（ChagtGPT vs ChatGPT）
  if (qLower.length >= 3 && aLower.length >= 3) {
    let longestCommonSubstr = '';
    for (let i = 0; i < qLower.length; i++) {
      for (let j = i + 3; j <= qLower.length; j++) {
        const sub = qLower.substring(i, j);
        if (aLower.includes(sub) && sub.length > longestCommonSubstr.length) {
          longestCommonSubstr = sub;
        }
      }
    }
    if (longestCommonSubstr.length >= 4 || longestCommonSubstr.length >= qLower.length * 0.5) return true;
  }

  return false;
}

// ===========================================================================
// 主判定：把「本地规则 + 商店检索结果」合成一份完整裁决
// ===========================================================================

/** 已判定项的实际覆盖范围（机器可读标记，供维护者与下游程序判读，不需要写进交付文案）。 */
export const SCRIPT_AUDIT_SCOPE = [
  '01 字符长度',
  '02 商店同名占用（限调用方指定的目标市场；仅 Apple 构成阻断）',
  '03 促销 / 排名 / 官方暗示违禁词',
  '04 Emoji 与非标符号',
  '05 无效占位命名',
];

/** 必须由调用方模型完成的判定项。任何面向用户的结论都必须先完成这些项。 */
export const MODEL_TASKS = [
  '完成 05 项商标与品牌判定：用你自己的品牌知识核查名称（含其中的词）是否与在先品牌或品类内知名产品冲突，给出风险等级（高 / 中 / 低）与理由。',
  '若品牌冲突成立，在 02 项补充「品牌词碰撞 / 冒充风险」结论，并据此修正整体裁决 —— 脚本不会替你补。',
  '给出针对该平台与品类的 ASO 命名点评，以及 2–4 个备选名。',
];

/**
 * @param {object} input
 * @param {string} input.name            拟用应用名称（已 trim）
 * @param {'apple'|'google'} input.platform
 * @param {string[]} input.markets       目标市场两字母码数组，如 ['us','hk']。**必填、无默认值** ——
 *        商店检索结果本身就是分市场返回的，不同市场的占用情况可以完全不同，
 *        替用户默认一个市场等于把「某个市场的结论」冒充成「用户市场的结论」。
 * @param {{market:string, ok:boolean, reason?:string, liveStoreMatches:any[],
 *          hasExactMatch:boolean, hasPrefixMatch:boolean}[]} input.marketScans
 *        逐市场检索结果。ok=false 表示该市场这次没跑完
 *        （network_failed / parser_failed / skipped），下游一律不得把 0 结果当成「无同名冲突」。
 * @param {any[]} input.liveStoreMatches 已算好 matchType 的检索结果（各市场并集，行内含 `country` 市场码）
 * @param {boolean} input.hasExactMatch  任一市场存在完全同名
 * @param {boolean} input.hasPrefixMatch 任一市场存在前缀命中
 * @param {string} input.country         兼容旧调用的单市场码，等价于 markets = [country]
 * @param {{apps:any[], ok:boolean, reason?:string}} input.storeScan 兼容旧调用的单市场检索结果
 */
export function evaluateName({
  name,
  platform = 'apple',
  country,
  markets,
  marketScans,
  storeScan,
  liveStoreMatches = [],
  hasExactMatch = false,
  hasPrefixMatch = false,
}) {
  const trimmedName = name.trim();
  const charCount = charLen(trimmedName);

  // 0. 市场。没有默认值：调用方必须明确给出目标市场。
  const marketList = (Array.isArray(markets) && markets.length
    ? markets
    : (country ? [country] : [])
  ).map((m) => String(m).trim().toUpperCase()).filter(Boolean);
  const marketLabel = marketList.join(' / ');

  // 1. 促销/排名/官方暗示词
  const foundBanned = checkBannedWords(trimmedName);
  const embeddedBanned = checkEmbeddedPromoWords(trimmedName).filter((w) => !foundBanned.includes(w));
  const promoFindings = buildPromoFindings(foundBanned, embeddedBanned);

  // 按阻断强度分档：
  //  · blocking —— 该词出现在名称里几乎只可能是宣传/违规宣称（免费、破解、官方、#1 …），命中即阻断
  //  · review   —— 该词同时是常见词或专名组成部分（Best Buy / TopHat / 第一财经 / 最好时光 …），
  //                凭命中本身无法区分「在宣称」还是「名字里恰好有这个字」，故不阻断、交模型按语境复核。
  //                这类词若也阻断，就是拿「命中了词库」冒充「命中了政策」，属假陈述。
  const allBanned = [...foundBanned, ...embeddedBanned];
  const blockingBanned = allBanned.filter((w) => promoStrengthOf(w) === 'blocking');
  const reviewBanned = allBanned.filter((w) => promoStrengthOf(w) === 'review');

  // 2. 占位 / 无意义名
  const placeholderCheck = checkPlaceholderOrGibberish(trimmedName, '应用名称');

  // 3. Emoji / 非标符号（🚀 🍎 ★ 1️⃣，含多码点组合序列）
  const foundEmojis = findEmojiAndSymbols(trimmedName);
  const hasEmoji = foundEmojis.length > 0;

  // 4. 品牌 / 商标：脚本不判定，只准备移交给模型的素材
  const brandReview = buildBrandReview(trimmedName);

  // 5. 检索状态（逐市场）
  //    reason 允许四种取值：completed / network_failed / parser_failed / skipped。
  //    skipped = 调用方主动跳过联网（--offline），措辞必须与「检索失败」区分开 ——
  //    把「用户没查」说成「查失败了」同样是不实陈述。
  //    多市场时只要有一个市场没跑完，就不得出具「全局无同名」的结论：
  //    此时 storeSearchStatus = 'partial'，逐市场结论仍可用，但必须标明哪些市场未核实。
  const scans = (Array.isArray(marketScans) && marketScans.length
    ? marketScans
    : [{
      market: marketList[0] ?? '',
      ok: !!storeScan?.ok,
      reason: storeScan?.reason,
      liveStoreMatches,
      hasExactMatch,
      hasPrefixMatch,
    }]
  ).map((s) => {
    // 兼容两种调用方：顶层 ok / 只给 storeScan.ok。任一缺失都按「未完成」处理（失效到保守侧）。
    const ok = s.ok ?? s.storeScan?.ok ?? false;
    const reason = s.reason ?? s.storeScan?.reason;
    return {
      market: String(s.market || '').toUpperCase(),
      ok: !!ok,
      reason: ok ? 'completed' : (reason ?? 'network_failed'),
      liveStoreMatches: Array.isArray(s.liveStoreMatches) ? s.liveStoreMatches : [],
      hasExactMatch: !!s.hasExactMatch,
      hasPrefixMatch: !!s.hasPrefixMatch,
    };
  });

  const okScans = scans.filter((s) => s.ok);
  const failedScans = scans.filter((s) => !s.ok && s.reason !== 'skipped');
  const skippedScans = scans.filter((s) => !s.ok && s.reason === 'skipped');
  const verifiedMarkets = okScans.map((s) => s.market);
  const allScansOk = scans.length > 0 && okScans.length === scans.length;
  const anyScanOk = okScans.length > 0;

  let storeSearchStatus;
  if (allScansOk) storeSearchStatus = 'completed';
  else if (anyScanOk) storeSearchStatus = 'partial';
  else if (skippedScans.length === scans.length) storeSearchStatus = 'skipped';
  else storeSearchStatus = failedScans[0]?.reason ?? 'network_failed';

  const storeLabel = platform === 'google' ? 'Google Play' : 'App Store';
  const reasonZh = (r) =>
    r === 'parser_failed' ? '解析器失效' : r === 'skipped' ? '主动跳过' : '网络请求失败';

  let storeSearchNote = '';
  if (storeSearchStatus === 'skipped') {
    storeSearchNote = `本次以离线模式运行，未执行 ${marketLabel || '目标市场'} 的 ${storeLabel} 商店实时检索，无法判断该名称是否已被占用或存在相近应用。`;
  } else if (storeSearchStatus === 'partial') {
    storeSearchNote = `已在 ${verifiedMarkets.join(' / ')} 完成 ${storeLabel} 检索，但 ${failedScans
      .map((s) => `${s.market}（${reasonZh(s.reason)}）`)
      .join('、')} 的检索未完成。未完成市场的同名与占用情况本次无法核实。`;
  } else if (storeSearchStatus !== 'completed') {
    storeSearchNote = `本次未能取得 ${marketLabel || '目标市场'} 的 ${storeLabel} 实时检索结果（检索未完成），无法判断该名称是否已被占用或存在相近应用。请稍后重试，或直接到 ${storeLabel} 手动检索确认。`;
  }

  /**
   * 市场核实范围声明。多市场下必须把「哪些市场真查了、哪些没查」写进结论措辞 ——
   * 否则「US 无同名」会被读成「所有目标市场都无同名」。
   */
  const marketScopeNote = allScansOk
    ? `已核实市场：${verifiedMarkets.join(' / ') || marketLabel}`
    : `已核实市场：${verifiedMarkets.join(' / ') || '（无）'}；未核实市场：${scans.filter((s) => !s.ok).map((s) => s.market).join(' / ')}`;


  // 6.2 竞争拥挤度按「单个市场的最大值」评估。
  //     多市场并集条数是累加的，用并集判阈值会让任何名称都显得拥挤
  //     （5 个市场各 1 条 → 并集 5 条 → 误判 High）。判定必须回到单市场口径。
  const maxMarketMatchCount = scans.reduce(
    (n, s) => Math.max(n, s.ok ? s.liveStoreMatches.length : 0),
    0
  );
  const anyMarketHasMatch = maxMarketMatchCount > 0;
  const anyMarketCrowded = scans.some(
    (s) => s.ok && (s.hasExactMatch || s.liveStoreMatches.length >= 3)
  );

  // 6. 平台裁决 —— 只反映脚本可判定的维度。
  //    品牌冒充维度整块移交模型（见 brandReview），这里不判：
  //    脚本没有能力也没有资格给出这个判断，宁可让它缺位，也不要凭静态词表猜。
  //    这里用 anyScanOk 而不是 allScansOk：多市场里只要有一个市场检索成功，
  //    该市场的命中就应当被如实呈现（未完成的市场由 storeSearchStatus 单独声明）。
  let appleVerdict = 'Clear';
  if (hasExactMatch || placeholderCheck.isBad) {
    appleVerdict = 'Taken';
  } else if (anyScanOk && (hasPrefixMatch || anyMarketHasMatch)) {
    appleVerdict = 'Close Matches';
  } else {
    appleVerdict = 'Clear';
  }

  let googleVerdict = 'Clear / Low Competition';
  if (placeholderCheck.isBad || blockingBanned.length > 0 || hasEmoji) {
    // 「Prohibited Words」这一档必须与 03/04 项的判定集合一致：独立词与内嵌词同级，
    // 只认独立词会让 FreeChat 出现「03 项已阻断、verdict 却说 Clear」的矛盾。
    // 按阻断强度取：待复核档（Best Buy / 第一财经 这类）不进 verdict，只进待复核。
    googleVerdict = 'Prohibited Words';
  } else if (anyScanOk && anyMarketCrowded) {
    googleVerdict = 'Crowded / Allowed';
  } else {
    googleVerdict = 'Clear / Low Competition';
  }

  // 7. 05 项素材：脚本只能给「名称占用」与「无效命名」两块，商标维度移交模型。
  //    05 项有几种不同性质的来源，必须分开陈述 —— 尤其「商店重名」不得说成「商标侵权」。
  const tmPrimaryCause =
    placeholderCheck.isBad ? 'placeholder'
      : hasExactMatch ? 'duplicate'
        : 'none';

  // 名称占用风险：商店同名 / 前缀相近 / 存在相关结果（与商标无关，独立呈现）
  // 超短名（1–3 字符）特例：只认完全同名，模糊结果不升级占用等级
  const ultraShortName = charCount < 4;
  const storeOccupancyRisk = hasExactMatch
    ? 'High'
    : (hasPrefixMatch || (!ultraShortName && anyMarketHasMatch)) ? 'Medium' : 'Low';

  const scriptConclusion =
    tmPrimaryCause === 'placeholder'
      ? `${placeholderCheck.reason}此类占位或重复字符名称不具备品牌识别度，会被按无效元数据处理（与是否重名无关）。`
      : tmPrimaryCause === 'duplicate'
        ? (platform === 'google'
          ? '商店中已存在完全同名的活跃应用。Google Play 允许重名，但同名会稀释品牌辨识度、分走自然搜索流量（属名称占用，不是商标侵权）。'
          // Apple 官方口径：名称唯一性按本地化（语言/地区）计，不是全局。
          // 原文见 Apple《添加新 App》FAQ：「针对 App 支持的每一种本地化语言，你可以分别提供一个 App 名称。」
          : '商店中已存在完全同名的活跃应用。App Store 名称在同一本地化（语言/地区）下唯一，该本地化已被占用时 App Store Connect 会拒绝该名称；未占用的本地化不受影响（属名称占用，不是商标侵权）。')
        : storeOccupancyRisk !== 'Low'
          ? '未发现无效命名问题；商店存在相近或相关应用（属名称占用）。'
          : '未发现无效命名与名称占用问题。';

  // 7.1 提审阻断项清单 —— 总裁决的唯一来源
  //
  // 「有没有问题」这件事必须只定义一次，否则 appleVerdict / googleVerdict /
  // 各项 status / 退出码 会各算一遍并互相打架。
  // ⚠️ 这里只装脚本可判定的阻断项；品牌冲突不在此列（脚本不做该判定），
  // 由模型在 05 项给出结论后自行补充，不得因为「blockers 为空」就断定名称可用。
  // appliesTo 标注该项对哪个平台成立：Google Play 允许重名，故同名占用只对 Apple 成立。
  const blockers = [];
  if (charCount > 30) {
    blockers.push({
      item: '01', appliesTo: 'both',
      label: `名称超长（${charCount}/30）`,
      detail: '超出两家商店标题字段的 30 字符硬性上限，后台保存时会被截断阻断。',
    });
  }
  if (hasExactMatch) {
    const hitMarkets = scans.filter((s) => s.hasExactMatch).map((s) => s.market).join(' / ');
    blockers.push({
      item: '02', appliesTo: 'apple',
      label: '商店已有完全同名应用',
      // hitMarkets 是「哪些目标市场检出同名」。Apple 的唯一性按本地化计，
      // 因此措辞限于「命中市场的本地化不可用，未命中的目标市场不受影响」。
      detail: `App Store 名称在同一本地化（语言/地区）下唯一。命中市场：${hitMarkets || marketLabel} —— 这些市场对应的本地化已无法使用该名称，未命中的目标市场不受影响（属名称占用，不是商标侵权）。`,
    });
  }
  if (blockingBanned.length > 0) {
    const standaloneBlocking = foundBanned.filter((w) => promoStrengthOf(w) === 'blocking');
    const embeddedBlocking = embeddedBanned.filter((w) => promoStrengthOf(w) === 'blocking');
    blockers.push({
      item: '03', appliesTo: 'both',
      label: '命中价格、促销或排名类禁用词',
      detail: [
        standaloneBlocking.length > 0 ? `独立词：${standaloneBlocking.join('、')}` : '',
        embeddedBlocking.length > 0 ? `内嵌连写：${embeddedBlocking.join('、')}` : '',
      ].filter(Boolean).join('；') + '。',
    });
  }
  if (hasEmoji) {
    blockers.push({
      item: '04', appliesTo: 'both',
      label: '名称含 Emoji 或非标符号',
      detail: `检出 ${foundEmojis.join(' ')}，Google 元数据政策明文禁止，Apple 侧会被名称字段校验拦下。`,
    });
  }
  if (placeholderCheck.isBad) {
    blockers.push({
      item: '02 · 05', appliesTo: 'both',
      label: '名称属于无意义占位串',
      detail: placeholderCheck.reason,
    });
  }

  const blockersFor = (p) => blockers.filter((b) => b.appliesTo === 'both' || b.appliesTo === p);

  // 警告级（不阻断提审，但影响审核效率或 ASO）
  // 只要有市场没跑完（含 --offline 全跳过）就至少是 Warning —— 未核实的市场不能当「没问题」。
  const hasWarning = (p) =>
    !allScansOk ||
    (p === 'apple' ? anyMarketHasMatch : googleVerdict === 'Crowded / Allowed');

  const auditStatusFor = (p) =>
    blockersFor(p).length > 0 ? 'Fail' : hasWarning(p) ? 'Warning' : 'Pass';

  // ⚠️ 这是「脚本可判定项」的唯一总结论。它不含品牌 / 商标维度 ——
  //    交付时必须先完成 modelTasks，再合并成对用户的结论。
  //    appleVerdict / googleVerdict 只是单一维度裁决，更不能当总判断用。
  const overallStatus = auditStatusFor(platform);
  const platformBlockers = blockersFor(platform);

  const trademarkAnalysis = {
    // 品牌 / 商标风险等级脚本不判定 → null 表示「待模型给出」。
    // 绝不能用 'Low' 冒充结论：没查过 ≠ 没问题。
    overallRisk: placeholderCheck.isBad ? 'High' : null,
    brandDimension: 'delegated',
    primaryCause: tmPrimaryCause,
    storeOccupancyRisk,
    classScope: TRADEMARK_CLASS_SCOPE,
    screeningScope: {
      // 机器可读的状态标记（不是给人看的句子）—— 任何「已做商标检索」的表述都与这三个 false 矛盾。
      isTrademarkDatabase: false,
      brandCheckPerformed: false,
      performedByScript: false,
    },
    verificationChannels: TRADEMARK_VERIFICATION_CHANNELS,
    scriptConclusion,
  };

  // 8. 独特性评分（仅作参考量，不进 01–05 项结论）
  let uniquenessScore = 85;
  if (placeholderCheck.isBad) uniquenessScore = 10;
  else if (hasExactMatch) uniquenessScore = 10;
  else if (hasPrefixMatch) uniquenessScore = 45;
  else if (blockingBanned.length > 0) uniquenessScore -= 20;
  else if (reviewBanned.length > 0) uniquenessScore -= 5;
  if (charCount > 30) uniquenessScore -= 25;
  uniquenessScore = Math.max(5, Math.min(100, uniquenessScore));

  // 9. 平台分析块与 feedback 不产出：它们各自带一套与 01–05 项并存的平行文案，
  //    会形成双真相源。判读文案一律以 report.mjs 的 01–05 项为准。

  return {
    platform,
    appName: trimmedName,
    charCount,
    uniquenessScore: hasEmoji ? Math.max(5, uniquenessScore - 30) : uniquenessScore,
    // 违禁词命中只保留这一份（promoFindings）：每条含 word / category / strength / 形态。
    // 不做「关键词堆砌」判定 —— app / tool 这类词在合法名称里很常见，按子串匹配会让
    // Happy / Sapporo / applicable 误报，对合法名称构成假陈述。
    promoFindings,
    // 命中但不足以据此阻断的词（Best Buy / TopHat / 第一财经 / 最好时光 这类）。
    // 不进 blockers，也不构成 Fail；报告里作为「待复核」呈现，由模型按语境判断是否属宣传性表述。
    promoReview: reviewBanned,
    foundEmojis,
    hasEmoji,
    appleVerdict,
    googleVerdict,
    nameIntegrity: {
      isBadPlaceholder: placeholderCheck.isBad,
      reason: placeholderCheck.reason || '',
    },
    storeSearchStatus,
    storeSearchNote,
    // 逐市场检索结果。报告按市场分节渲染；多市场时不得把并集当成单一市场的结论。
    marketScans: scans.map((s) => ({
      market: s.market,
      status: s.reason,
      matches: s.liveStoreMatches,
      matchCount: s.liveStoreMatches.length,
      hasExactMatch: s.hasExactMatch,
      hasPrefixMatch: s.hasPrefixMatch,
    })),
    liveStoreMatches,
    trademarkAnalysis,
    // 品牌 / 商标判定任务包：targets 是候选检查词，contract 是必须满足的输出契约
    brandReview,
    // 提审总裁决（按当前平台）。只覆盖脚本可判定项，仍是唯一真相源。
    overallStatus,
    auditScope: SCRIPT_AUDIT_SCOPE,
    blockers: platformBlockers,
    // 必须由调用方模型完成的判定项 —— 交付前必须全部完成
    modelTasks: MODEL_TASKS,
    // 目标市场（数组）与展示用标签。检索结果分市场返回，结论必须带市场范围。
    marketsSearched: marketList,
    countrySearched: marketLabel,
    marketScopeNote,
    // 脚本侧全部未命中时，报告自身几乎没有内容 —— 此时最值得补一段 ASO 点评/备选名
    aiEnhancementSuggested:
      !hasEmoji &&
      !placeholderCheck.isBad &&
      blockingBanned.length === 0 &&
      reviewBanned.length === 0 &&
      charCount <= 30,
  };
}
