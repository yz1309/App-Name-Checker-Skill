/**
 * 报告渲染：把 engine.mjs 的判定结果排成 01–05 项审计报告。
 *
 * 01 字符长度审计 / 02 同名与排他性 / 03 价格、促销与排名词 /
 * 04 符号与 Emoji 禁令 / 05 商标与法务预检。
 *
 * ⚠️ 05 项不由脚本判定 —— 脚本只给素材与契约，结论必须由调用方模型补上。
 *    因此报告里 05 项的状态是 `delegated`（pill「未判定」）。
 *    「未判定」只由这一处结构性状态表达，报告正文与横幅都不写成句的边界声明 ——
 *    成句会被调用方模型原样抄进交付文档，而交付文档里 05 项已由模型补上，抄进去即自相矛盾。
 *    给维护者的待办提示走 stderr（见 renderReport 里的 `[待办]` 行）。
 */

import { PROMO_CATEGORY_LABEL, PROMO_CATEGORY_ORDER, charLen } from './engine.mjs';

const icon = (status) =>
  status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : status === 'delegated' ? '🧭' : '⛔';
const STATUS_LABEL = { pass: '通过', warn: '建议优化', fail: '提审阻断', delegated: '本项未判定' };

/** 组一个审计项 */
const item = (no, title, status, pill, desc) => ({ no, title, status, pill, desc });

/** 商店匹配度排序权重：完全同名最前，让「有没有撞名」一眼可见 */
const MATCH_WEIGHT = { 'Exact Match': 0, 'Prefix Match': 1, 'Contains Match': 2 };
const MATCH_LABEL = {
  'Exact Match': '完全同名',
  'Prefix Match': '前缀匹配',
  'Contains Match': '包含匹配',
};
const matchLabel = (t) => MATCH_LABEL[t] ?? '相关关键词';
const matchWeight = (t) => MATCH_WEIGHT[t] ?? 3;

/** 逐市场检索状态的中文标签。'completed' 不在此表内（已完成的市场直接出结果表）。 */
const REASON_LABEL = {
  skipped: '离线未检索',
  network_failed: '网络请求失败',
  parser_failed: '解析器失效',
  partial: '部分市场未完成',
};
const reasonLabel = (s) => REASON_LABEL[s] ?? '检索未完成';

/** 按匹配度分档计数 */
function countByMatch(matches) {
  const c = { 'Exact Match': 0, 'Prefix Match': 0, 'Contains Match': 0, other: 0 };
  for (const m of matches) {
    if (m.matchType === 'Exact Match') c['Exact Match'] += 1;
    else if (m.matchType === 'Prefix Match') c['Prefix Match'] += 1;
    else if (m.matchType === 'Contains Match') c['Contains Match'] += 1;
    else c.other += 1;
  }
  return c;
}

/**
 * 逐市场一句话概述。多市场时结论必须落到市场粒度 ——
 * 把「US 没有同名」写成「没有同名」就是假陈述。
 */
function buildMarketBreakdown(scans) {
  return scans
    .map((s) => {
      if (s.status !== 'completed') return `${s.market}：${reasonLabel(s.status)}`;
      const ex = s.matches.find((m) => m.matchType === 'Exact Match');
      if (ex) return `${s.market}：命中完全同名《${ex.name}》`;
      const n = s.matches.length;
      return n > 0 ? `${s.market}：${n} 款相近，无完全同名` : `${s.market}：未见同名或相近`;
    })
    .join('；');
}

function buildAuditItems(platform, result, appName) {
  const isApple = platform === 'apple';
  const platformLabel = isApple ? 'Apple' : 'Google';
  const consoleName = isApple ? 'App Store Connect' : 'Play Console';
  const len = charLen(appName);
  const items = [];

  const exactMatch = result.liveStoreMatches.find((m) => m.matchType === 'Exact Match');
  const isBadPlaceholder = result.nameIntegrity?.isBadPlaceholder ?? false;
  const countryLabel = result.countrySearched?.toUpperCase() || '';
  // 商店实时检索是否真的跑完。未完成时 02 项必须如实说明，不能落到「无同名占用」。
  const storeUnverified = result.storeSearchStatus !== 'completed';
  // 主动跳过联网（--offline）与「检索失败」是两回事，措辞必须分开；
  // 多市场下部分失败又是第三种情况，pill 必须能区分出来。
  const storeSkipped = result.storeSearchStatus === 'skipped';
  const unverifiedPill = storeSkipped
    ? '离线未检索'
    : result.storeSearchStatus === 'partial' ? '部分市场未完成' : '检索未完成';

  // ── 01 字符长度审计 ────────────────────────────────────────────────
  items.push(
    item(
      '01',
      '字符长度审计',
      len <= 30 ? 'pass' : 'fail',
      len <= 30 ? '长度合规' : `超长 ${len - 30} 字符（${len}/30）`,
      (len <= 30
        ? `符合 ${platformLabel} 标题 30 个字符上限要求，${consoleName} 后台可直接保存，无截断风险。`
        : `当前名称为 ${len} 字符，已超出 ${consoleName} 后台 30 字符硬性上限，保存时系统将直接弹窗截断阻断。建议将副标题拆分移入 30 字符的 ${isApple ? 'Subtitle' : '简短说明'} 字段。`)
    )
  );

  // ── 02 同名与排他性 ────────────────────────────────────────────
  // 注意：appleVerdict === 'Taken' 只有两个来源（真同名 / 无意义占位名），
  // 必须按事实来源分派文案，否则会出现「检索卡说未检索到同名，本项却说同名已锁定」的自相矛盾。
  // 这两个来源已由下方 exactMatch / isBadPlaceholder 两支完全覆盖，不再设 'Taken' 兜底分支。
  // 若日后 engine 给 'Taken' 增加新来源而此处没同步，toneMismatch 哨兵会报警到 stderr。
  // ⚠️ 脚本不做品牌判定，「品牌词碰撞」类结论由模型在 05 项给出后自行补充。
  // ⚠️ 多市场：结论必须落到市场粒度。把「US 没有同名」写成「没有同名」就是假陈述。
  const scans = result.marketScans ?? [];
  const multiMarket = scans.length > 1;
  const marketBreakdown = scans.length ? buildMarketBreakdown(scans) : '';
  const anyMarketVerified = scans.some((s) => s.status === 'completed');
  const verifiedPart = anyMarketVerified ? `已完成的市场的检索结果 —— ${marketBreakdown}。` : '';
  // 多市场部分失败时不要把「检索未完成」和「已查到的结果」混在一句里重复说
  const unverifiedHead = result.storeSearchStatus === 'partial'
    ? '本次为多市场检索，**部分市场未完成**。'
    : `${result.storeSearchNote || '本次商店实时检索未完成。'}`;

  if (isApple) {
    const v = result.appleVerdict;
    if (exactMatch) {
      const hitMarkets = scans.filter((s) => s.hasExactMatch).map((s) => s.market).join(' / ');
      items.push(item('02', '同名与排他性', 'fail', '同名已锁定',
        `检索到完全同名的活跃应用《${exactMatch.name}》（${exactMatch.developer}），命中市场：**${hitMarkets || countryLabel}**。App Store 名称在同一本地化（语言/地区）下唯一，命中市场对应的本地化已无法使用该名称，未命中的目标市场不受影响（属名称占用，不是商标侵权）。如需在命中市场上架，需更换名称或增加独特品牌前缀。`));
    } else if (isBadPlaceholder) {
      items.push(item('02', '同名与排他性', 'fail', '名称无效被拦',
        `${result.nameIntegrity?.reason || '名称被判定为无意义占位串或重复字符。'}名称本身不具备品牌识别性，App Store 审核指南禁止提交此类占位名称，与是否重名无关。`));
    } else if (storeUnverified) {
      items.push(item('02', '同名与排他性', 'warn', unverifiedPill,
        `${unverifiedHead}${verifiedPart}未完成市场的同名与占用情况本次无法判断。`));
    } else if (v === 'Close Matches' || (result.liveStoreMatches?.length ?? 0) > 0) {
      items.push(item('02', '同名与排他性', 'warn', '存在相似名',
        `在 ${countryLabel} 市场检索到 ${result.liveStoreMatches.length} 款相近应用（各市场合计），暂无完全同名占用；建议差异化命名，以降低审核混淆与 ASO 竞争风险。${multiMarket ? `\n逐市场：${marketBreakdown}。` : ''}`));
    } else {
      items.push(item('02', '同名与排他性', 'pass', '无同名占用',
        `已在 ${countryLabel} 的 App Store 完成检索，未检索到同名或相近应用（${result.marketScopeNote ?? ''}）。${multiMarket ? `\n逐市场：${marketBreakdown}。` : ''}`));
    }
  } else {
    const v = result.googleVerdict;
    if (isBadPlaceholder) {
      items.push(item('02', '同名与排他性', 'fail', '名称无效被拦',
        `${result.nameIntegrity?.reason || '名称被判定为无意义占位串或重复字符。'}Google Play 元数据政策要求名称具备实际意义，此类占位名称无法通过审核，与是否重名无关。`));
    } else if (storeUnverified) {
      items.push(item('02', '同名与排他性', 'warn', unverifiedPill,
        `${unverifiedHead}${verifiedPart}未完成市场的同名与占用情况本次无法判断。`));
    } else if (v === 'Crowded / Allowed') {
      items.push(item('02', '同名与排他性', 'warn', '竞争拥挤',
        `Google 允许重名，但在 ${countryLabel} 市场检索到 ${result.liveStoreMatches.length} 款相近应用（单市场最多 ${Math.max(...scans.map((s) => (s.status === 'completed' ? s.matches.length : 0)), 0)} 款），存在搜索竞争与用户混淆风险，建议差异化命名提升辨识度。${multiMarket ? `\n逐市场：${marketBreakdown}。` : ''}`));
    } else {
      items.push(item('02', '同名与排他性', 'pass', '无强冲突',
        `已在 ${countryLabel} 的 Google Play 完成检索，未检索到强冲突同名应用（${result.marketScopeNote ?? ''}）。${multiMarket ? `\n逐市场：${marketBreakdown}。` : ''}`));
    }
  }

  // ── 03 价格、促销与排名词 ──────────────────────────────────────────
  const findings = result.promoFindings ?? [];
  // 只把「无合法歧义」的词算作阻断；有合法用法的词（Best Buy / TopHat / 第一财经 / 最好时光）
  // 单凭命中无法区分「在宣称」还是「名字里恰好有这个字」，降级为待复核，交模型按语境判断。
  const blocking = findings.filter((f) => f.strength !== 'review');
  const reviewOnly = findings.filter((f) => f.strength === 'review');
  const wordsFail = blocking.length > 0;
  const hasEmbedded = blocking.some((f) => f.form === 'embedded');
  const grouped = PROMO_CATEGORY_ORDER
    .map((c) => ({ c, list: blocking.filter((f) => f.category === c) }))
    .filter((g) => g.list.length > 0)
    .map((g) => `  · ${PROMO_CATEGORY_LABEL[g.c]}：${g.list.map((f) => `\`${f.word}\``).join('、')}`)
    .join('\n');
  const reviewLine = reviewOnly.length > 0
    ? `\n\n另检出 ${reviewOnly.map((f) => `\`${f.word}\``).join('、')} —— 这类词同时是常见词或既有专名的组成部分（如 Best Buy、TopHat、第一财经、最好时光），是否属于宣传性表述取决于名称整体语义，需按语境确认。`
    : '';

  items.push(
    item(
      '03',
      '价格、促销与排名词',
      // 只用 warn 不用 delegated：delegated 是 05 项「移交模型、未判定」的专属状态，
      // 03 项若也置为 delegated，会让 stderr 的 [待办] 行误报 05 项未判定
      //（05 项可能已由模型补齐）。
      wordsFail ? 'fail' : (reviewOnly.length > 0 ? 'warn' : 'pass'),
      wordsFail ? `检出 ${blocking.length} 个禁用词` : (reviewOnly.length > 0 ? `检出 ${reviewOnly.length} 个需按语境确认的词` : '无禁用词'),
      // ↑ pill 与文案都不写「未判定」：本项已判定，只是结论为「需按语境确认」而非阻断。
      wordsFail
        ? (isApple
            ? `命中 App Store 审核指南 2.3.7：元数据不得夹带「pricing information」，应用名称与副标题「should not include prices」，副标题亦不得做无法验证的宣称。\n${grouped}`
            : `命中 Google Play《元数据》政策：应用名称不得涉及「商店内的表现或排名、价格或促销信息」，也不得暗示与现有 Google Play 计划有关；《商店信息最佳做法》并逐字点名「免费」「无广告」这类词不得出现在应用名称中。\n${grouped}`)
          + (hasEmbedded
            ? '\n（其中部分以品牌词内嵌形态出现，如 FreeChat / freechat。官方条款按语义判定——名称只要携带价格或促销含义即落入禁用范围，建议改为不含促销含义的独创品牌词。）'
            : '')
          + reviewLine
        : (reviewOnly.length > 0
          ? reviewLine.trim()
          : (isApple
            ? '未检出价格信息或无法验证的排名宣称（Free / 免费 / Discount / Best / Top / #1 等），也无「官方」「编辑精选」类计划暗示，符合 2.3.7 对元数据内容的要求。'
            : '未检出涉及商店表现或排名、价格或促销信息的词汇，也无「官方」「编辑精选」类计划暗示，符合《元数据》政策对应用名称的要求。'))
    )
  );

  // ── 04 符号与 Emoji 禁令 ───────────────────────────────────────────
  const emojiFail = result.hasEmoji && result.foundEmojis.length > 0;
  items.push(
    item(
      '04',
      '符号与 Emoji 禁令',
      emojiFail ? 'fail' : 'pass',
      emojiFail ? `检出非标字符：${result.foundEmojis[0]}` : '无违禁符号',
      emojiFail
        ? (isApple
            ? `命中 App Store 审核指南 2.3.7：应用名称只能是名称本身，不得夹带与该元数据类型无关的描述，Emoji 与非标符号不构成可辨识名称。需删除 ${result.foundEmojis.map((e) => `「${e}」`).join('、')} 后重新提审。`
            : `命中 Google Play《元数据》政策原文「请勿在应用名称、图标和开发者名称中使用表情符号、颜文字或重复的特殊字符」。需删除 ${result.foundEmojis.map((e) => `「${e}」`).join('、')} 后重新提审（官方违规示例即 “Crane: travel PLANNER!! 🌞”）。`)
        : (isApple
            // 措辞必须与实际检测范围一致：检测覆盖 Emoji、装饰性符号（★ ☆ ♥）、
            // 商标/版权符号（™ © ®）与 1️⃣ 这类组合序列。
            ? '未检出 Emoji 表情（如 🚀 ⭐）、装饰性符号（如 ★ ❤）、商标/版权符号（如 ™ © ®）或其他非标字符，名称仅为可辨识的文字内容，2.3.7 元数据规范无异议。'
            : '未检出 Emoji、颜文字、装饰性符号或商标/版权类特殊字符，符合《元数据》政策对名称符号的要求。'))
  );

  // ── 05 商标与法务预检（**移交模型**）─────────────────────────────
  // 脚本不内置品牌词表，因此不给商标风险等级。
  // 本项状态固定为 delegated，把素材与契约交给调用它的模型去完成。
  const tm = result.trademarkAnalysis ?? {};
  const brandReview = result.brandReview ?? {};
  const tmDelegated = !result.nameIntegrity?.isBadPlaceholder;
  const tmStatus = tmDelegated ? 'delegated' : 'fail';
  const tmPill = tmDelegated ? '未判定' : '名称无效';

  const lines = [];
  if (!tmDelegated) {
    lines.push(tm.scriptConclusion || '名称属于无效占位串，本项直接判阻断。');
  } else {
    // 本节只呈现事实素材。mustCheck / 结论格式 / 禁止声称项属于「写给调用方模型」的内部约定，
    // 已在 JSON 的 brandReview.contract 与 SKILL.md 里；把它们渲染进报告只会被原样抄进交付文档，
    // 而用户要看的是素材与结论，不是脚本的工作清单。
    lines.push(`名称中值得对照品牌与商标库核查的词：${(brandReview.targets ?? []).map((t) => `\`${t}\``).join('、') || '（无）'}`);
    if (tm.classScope?.length) {
      lines.push(`需核查尼斯类别：${tm.classScope.map((c) => `第 ${c.code} 类（${c.label}）`).join(' · ')}`);
    }
    if (tm.verificationChannels?.length) {
      lines.push(`官方核查渠道：${tm.verificationChannels.map((c) => `[${c.name}](${c.url})`).join(' · ')}`);
    }
    lines.push(`名称占用风险（与商标无关）：${tm.storeOccupancyRisk === 'High' ? '高' : tm.storeOccupancyRisk === 'Medium' ? '中' : '低'} —— ${tm.scriptConclusion || ''}`);
  }

  items.push(item('05', '商标与法务预检', tmStatus, tmPill, lines.join('\n')));

  return items;
}

/** 渲染完整 Markdown 报告 */
export function renderReport(result) {
  const platform = result.platform;
  const isApple = platform === 'apple';
  const platformLabel = isApple ? 'Apple' : 'Google';
  const storeLabel = isApple ? 'App Store' : 'Google Play';
  const consoleName = isApple ? 'App Store Connect' : 'Play Console';
  const appName = result.appName;
  const items = buildAuditItems(platform, result, appName);
  const platformBlockers = result.blockers ?? [];

  const fails = items.filter((i) => i.status === 'fail');
  const warns = items.filter((i) => i.status === 'warn');
  // 裁决取 overallStatus（引擎给出的唯一真相源），并核对 01–05 项算出的结论是否一致。
  // 两者若不一致说明「阻断项定义」在两处漂移了 —— 宁可显式报警，也不要让报告自相矛盾。
  const toneFromItems = fails.length > 0 ? 'fail' : warns.length > 0 ? 'warn' : 'pass';
  const toneFromStatus = result.overallStatus === 'Fail' ? 'fail' : result.overallStatus === 'Warning' ? 'warn' : result.overallStatus === 'Pass' ? 'pass' : toneFromItems;
  const tone = toneFromStatus;
  const toneMismatch = toneFromItems !== toneFromStatus;

  const storeUnverified = result.storeSearchStatus !== 'completed';
  // 05 项是否仍待模型判定。占位名场景下 05 已由脚本判为 fail（名称无效是脚本能确定的事实），
  // 此时不该再提示「05 项待完成」。
  // 按项号锁定 05 项，不用 status === 'delegated' 全局匹配 ——
  // 后者会把任何同样置为 delegated 的项误认成 05 项未判定。
  const brandPending = items.some((i) => i.no === '05' && i.status === 'delegated');

  const bannerBase =
    tone === 'pass' ? '未发现提审阻断项'
      : tone === 'warn' ? `存在 ${warns.length} 项优化建议`
        : `发现 ${platformBlockers.length} 项提审阻断`;
  const bannerPill = tone === 'pass' ? '待复核' : tone === 'warn' ? '建议优化' : '提审被拦截';

  // 05 项「未判定」不写成句声明：只由 05 项小节的状态 pill 表达，待办提示写 stderr。
  // 成句声明会被调用方模型原样抄进交付文档，而交付文档里 05 项已由模型补上，抄进去即自相矛盾。
  // 检索未完成有三种成因，横幅必须区分（尤其「部分市场未完成」与「离线未检索」）
  const storeCaveat = !storeUnverified ? ''
    : result.storeSearchStatus === 'partial'
      ? ` 注意：本次 ${storeLabel} 检索只完成了部分市场（${(result.marketScans ?? []).filter((s) => s.status === 'completed').map((s) => s.market).join(' / ')}），未完成市场的同名与占用情况本次未能核实。`
      : result.storeSearchStatus === 'skipped'
        ? ` 注意：本次为离线模式，未执行 ${storeLabel} 商店实时检索，同名与占用情况本次未能核实。`
        : ` 注意：本次 ${storeLabel} 商店实时检索未完成，同名与占用情况本次未能核实。`;
  const bannerDesc =
    tone === 'pass'
      // 检索未完成时绝不能说「未检索到同名」—— 没查过 ≠ 没有。
      // 02 项此时必为 warn，但 overallStatus 仍可能因「无阻断项」给 Pass，所以这一层是独立兜底。
      ? (storeUnverified
        ? `名称「${appName}」已通过本次各项可判定检查。${storeCaveat}`
        : `名称「${appName}」在目标市场（${result.countrySearched}）未检索到同名占用。`)
      : tone === 'warn'
        ? `名称「${appName}」暂无硬性提审阻断，但存在影响审核效率或 ASO 表现的因素，建议按下方审计项优化。${storeCaveat}`
        : `名称「${appName}」存在提审阻断项，请按下方审计明细逐条修正后再提审。`;

  const out = [];
  out.push(`# ${platformLabel} 命名政策审计报告`);
  out.push('');
  out.push(`**被检名称**：\`${appName}\`　|　**字符数**：${result.charCount} / 30　|　**目标市场**：${result.countrySearched}　|　**平台**：${platformLabel}`);
  out.push('');
  out.push(`${icon(tone)} **${bannerBase}**　\`${bannerPill}\``);
  out.push('');
  out.push(`> ${bannerDesc}`);
  out.push('');

  if (brandPending) {
    // 05 项未判定只在这里（维护者可见）和 05 项小节的状态 pill 里出现。
    // 报告正文不放成句声明：它被抄进交付文档后会与「模型已补上的 05 项结论」自相矛盾。
    process.stderr.write('[待办] 05 项商标与法务预检未判定，需由调用方模型补入结论后，再对外交付本报告。\n');
  }

  // 阻断项清单：给「要改哪几条」一个直接答案，不用让读者自己在五项里找红叉
  if (platformBlockers.length > 0) {
    out.push('## 提审阻断项');
    out.push('');
    for (const b of platformBlockers) {
      out.push(`- **${b.item} ${b.label}** —— ${b.detail}`);
    }
    out.push('');
  }

  if (toneMismatch) {
    // 一致性告警是给维护者的诊断（含源文件名与字段名），不是给用户的内容 ——
    // 写 stderr，报告正文不出现。
    process.stderr.write(
      `[内部一致性告警] overallStatus=${result.overallStatus}（${toneFromStatus}），`
      + `但 01–05 项逐项算出 ${toneFromItems}。`
      + `「什么算阻断」在 engine.mjs 与 report.mjs 之间已漂移，请核对 blockersFor()。\n`
    );
  }

  out.push('## 审计明细');
  out.push('');
  for (const it of items) {
    out.push(`### ${it.no} ${it.title}　${icon(it.status)} ${STATUS_LABEL[it.status]}　\`${it.pill}\``);
    out.push('');
    out.push(it.desc);
    out.push('');
  }

  // ── 商店检索结果：按市场分节，明细完整列出，供多市场 / 两平台对照 ────────
  // 检索结果分市场返回，因此每个市场一张表 —— 合并成一张会让读者误把
  // 「某个市场的结果」当成「所有目标市场的结果」。
  const storeScans = result.marketScans ?? [];
  const multiMarketStore = storeScans.length > 1;
  out.push(`## ${storeLabel} 实时检索结果${multiMarketStore ? '' : `（${result.countrySearched}）`}`);
  out.push('');

  if (multiMarketStore) {
    out.push(`目标市场共 ${storeScans.length} 个：**${storeScans.map((s) => s.market).join(' / ')}**。检索结果分市场返回、**不可互相替代** —— 同一名称在不同市场的占用情况可能完全不同。`);
    out.push('');
    out.push('| 市场 | 检索状态 | 完全同名 | 前缀匹配 | 包含匹配 | 相关关键词 | 合计 |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of storeScans) {
      if (s.status !== 'completed') {
        out.push(`| ${s.market} | ${reasonLabel(s.status)} | - | - | - | - | - |`);
      } else {
        const c = countByMatch(s.matches);
        out.push(`| ${s.market} | 已检索 | ${c['Exact Match']} | ${c['Prefix Match']} | ${c['Contains Match']} | ${c.other} | ${s.matches.length} |`);
      }
    }
    out.push('');
  }

  for (const s of storeScans) {
    if (multiMarketStore) {
      out.push(`### ${s.market}`);
      out.push('');
    }
    if (s.status !== 'completed') {
      out.push(`⚠️ **${s.market} 的 ${storeLabel} 实时检索未完成**（${reasonLabel(s.status)}）。`);
      out.push('');
      out.push(s.status === 'skipped'
        ? '本次为离线模式，未执行该市场的检索。'
        : '本次未取得该市场的实时数据 —— 未取得数据不代表该市场没有同名应用。');
      out.push('');
      continue;
    }
    const matches = [...s.matches].sort((a, b) => matchWeight(a.matchType) - matchWeight(b.matchType));
    if (matches.length === 0) {
      out.push(`✅ 在 ${s.market} 的 ${storeLabel} 未检索到同名或强相关应用（检索已完成，返回 0 条）。`);
      out.push('');
      continue;
    }
    const c = countByMatch(matches);
    const tally = [
      ['Exact Match', c['Exact Match']],
      ['Prefix Match', c['Prefix Match']],
      ['Contains Match', c['Contains Match']],
      ['other', c.other],
    ]
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t === 'other' ? '相关关键词' : matchLabel(t)} ${n} 款`)
      .join(' · ');
    out.push(`在 ${s.market} 的 ${storeLabel} 检索到 **${matches.length} 款**结果：${tally}`);
    out.push('');
    out.push(`| # | 应用名 | ${isApple ? '开发者' : '开发者（未校验）'} | 匹配度 | 链接 |`);
    out.push('| --- | --- | --- | --- | --- |');
    matches.forEach((m, i) => {
      const url = m.url || (m.bundleId && m.bundleId.includes('.') ? `https://play.google.com/store/apps/details?id=${m.bundleId}` : '');
      out.push(`| ${i + 1} | ${m.name} | ${m.developer || '-'} | ${matchLabel(m.matchType)} | ${url ? `[查看](${url})` : '-'} |`);
    });
    out.push('');
  }

  if (storeUnverified) {
    // 长说明统一放本节末尾，避免在每个市场块里重复一遍
    out.push(`> ⚠️ ${result.storeSearchNote}`);
    out.push('');
  }
  out.push(multiMarketStore
    ? '> 以上为各市场的完整检索结果，均未截断。**不同市场不可互相替代**，勿用其中一个市场的结论代表整体。'
    : '> 以上为本次检索的完整结果，未截断。');
  out.push('');

  // Google 侧开发者字段未经校验 —— 它来自混淆类名（会变）或卡片文本兜底，两者都按
  // 「就近取值」在 ±2500 字符窗口内匹配，实测会串到相邻应用（仅 2/29 走兜底，但错位出现在更多行，
  // 说明主因是窗口过大而非兜底）。未经校验的字段不得被当成准确信息引用。
  //
  // 这个事实只在两处表达：本表**表头的「（未校验）」标注** + SKILL.md 交付要求第 4 条。
  // 刻意不写成表末的整段免责声明 —— 那种段落会被调用方模型原样抄进交付文档，
  // 用户要的是结论，不是脚本的字段来源说明与引用规范。

  // 参考信息（商标筛查边界、尼斯类别、核查渠道都已在 05 项给出，这里不再重复）
  out.push('## 参考');
  out.push('');
  out.push(`- 独特性评分：${result.uniquenessScore} / 100（仅供横向对比，非审核结论）`);

  return out.join('\n');
}
