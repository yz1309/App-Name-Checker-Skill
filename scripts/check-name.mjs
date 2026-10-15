#!/usr/bin/env node
/**
 * 苹果与谷歌商店应用名称检查 — 命令行入口
 *
 * 用法：
 *   node check-name.mjs "Zenith Markdown Editor" -c us
 *   node check-name.mjs "Calculator" -c us,hk,jp              # 默认 Apple + Google 都查
 *   node check-name.mjs "MyApp" -c cn --offline               # 跳过商店联网检索，只跑本地规则
 *   node check-name.mjs "Calculator" -p google -c us          # 只查一个平台时才传 -p
 *
 * 参数：
 *   <name>                        拟用应用名称（必填，也可用 --name 传入）
 *   -p, --platform both|apple|google  **默认 both** —— 一次把两个平台都查完，输出两份报告。
 *                                 只查一个平台（调试 / 单平台产品）时才需要显式传。
 *   -c, --country <cc[,cc...]>    **必填**。目标市场两字母码，可多选（逗号分隔）或重复传
 *                                 （--market 是等价别名）。没有默认市场 —— 商店检索结果
 *                                 分市场返回，不同市场的占用情况可以完全不同。
 *       --offline                 不联网，只做本地规则判定（02 项会显示「离线未检索」）
 *       --json                    输出原始 JSON（**数组，一项 = 一个平台**），默认输出 Markdown
 *   -h, --help                    显示帮助
 *
 * 退出码：0 = 无提审阻断；1 = 任一平台存在提审阻断（overallStatus = Fail）；2 = 参数或运行错误。
 */

import { NAME_INPUT_MAX, charLen, evaluateName } from './engine.mjs';
import { scanStore } from './store.mjs';
import { renderReport } from './report.mjs';

/**
 * 常用市场。仅用于帮助与错误提示文案 —— 校验只要求「两位字母码」，
 * 因此 Apple / Google 覆盖的其他地区（nl / th / mx …）也能直接传。
 */
export const COMMON_MARKETS = [
  ['us', '美国'], ['cn', '中国大陆'], ['hk', '中国香港'], ['tw', '中国台湾'], ['mo', '中国澳门'],
  ['jp', '日本'], ['kr', '韩国'], ['sg', '新加坡'], ['gb', '英国'],
  ['id', '印度尼西亚'], ['br', '巴西'], ['de', '德国'], ['fr', '法国'],
  ['ca', '加拿大'], ['au', '澳大利亚'],
];

const MARKET_HELP = COMMON_MARKETS.map(([c, n]) => `${c} ${n}`).join(' / ');

function parseArgs(argv) {
  const opts = { name: null, platform: 'both', markets: [], offline: false, json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--offline' || a === '--no-store') opts.offline = true;
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '-p' || a === '--platform') opts.platform = String(argv[++i] || '').toLowerCase();
    else if (a === '-c' || a === '--country' || a === '-m' || a === '--market') opts.markets.push(argv[++i]);
    else if (a.startsWith('--platform=')) opts.platform = a.slice(11).toLowerCase();
    else if (a.startsWith('--country=')) opts.markets.push(a.slice(10));
    else if (a.startsWith('--market=')) opts.markets.push(a.slice(9));
    else if (a.startsWith('--name=')) opts.name = a.slice(7);
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}`);
    else rest.push(a);
  }
  if (!opts.name && rest.length) opts.name = rest.join(' ');
  return opts;
}

/**
 * 把 -p/--platform 的入参展开成「要跑的平台列表」。
 *
 * **默认 both**：两平台的命名规则与商店接口完全不同 —— Apple 名称在同一本地化（语言/地区）下唯一、
 * 同名会被拦；Google Play 允许重名但严打冒充。只看一个平台就下结论，
 * 等于把「一半的结论」当完整结论交付。所以默认一次跑完两平台，
 * `-p` 只在确实只想看单个平台时才需要传。
 */
export function resolvePlatforms(raw) {
  const p = String(raw ?? 'both').trim().toLowerCase();
  if (p === '' || p === 'both' || p === 'all' || p === '*') return ['apple', 'google'];
  if (p === 'apple' || p === 'ios') return ['apple'];
  if (p === 'google' || p === 'android') return ['google'];
  throw new Error(`平台不合法：「${raw}」。可选 apple / google / both（默认 both，两个平台都查）。`);
}

/** 把 -c/--country 的原始入参（可重复、可逗号/斜杠分隔）整理成去重后的市场码数组 */
export function normalizeMarkets(raw) {
  const list = [];
  for (const entry of raw ?? []) {
    for (const part of String(entry ?? '').split(/[,，/、\s]+/)) {
      const code = part.trim().toLowerCase();
      if (!code) continue;
      if (!/^[a-z]{2}$/.test(code)) {
        throw new Error(`市场代码不合法：「${part}」。应为两位字母码，如 us / jp / hk。`);
      }
      if (!list.includes(code)) list.push(code);
    }
  }
  return list;
}

const HELP = `苹果与谷歌商店应用名称检查 —— 命令行用法

  node check-name.mjs "<应用名称>" -c <市场> [选项]

必填：
  -c, --country <cc[,cc...]>    目标市场两字母码。可多选（逗号分隔）或重复传
                                （--market 为等价别名）。**没有默认市场** ——
                                商店检索结果分市场返回，不同市场的名称占用情况
                                可以完全不同，所以必须显式指定。

选项：
  -p, --platform both|apple|google
                                目标平台，**默认 both** —— 一次把 Apple 与 Google
                                都查完，输出两份报告（两平台规则不同，不可互相替代）。
                                只在确实想单看一个平台时才传。
      --offline                 跳过商店联网检索，只跑本地规则判定
                                （02 项会显示「离线未检索」而非「检索失败」）
      --json                    输出原始 JSON（数组，一项 = 一个平台），默认输出 Markdown
  -h, --help                    显示本帮助

常用市场：
  ${MARKET_HELP}

退出码：0 = 无提审阻断；1 = 任一平台存在提审阻断（overallStatus = Fail）；2 = 参数或运行错误。

示例：
  node check-name.mjs "Zenith Markdown Editor" -c us
  node check-name.mjs "Calculator" -c us,hk
  node check-name.mjs "Spotify Clone" -c cn --offline
  node check-name.mjs "Calculator" -p google -c us    # 只看 Google 时才需要传 -p
`;

/**
 * 跑一个平台的完整检查（检索 + 判定）。
 * @param {object} opts  CLI 解析后的选项
 * @param {'apple'|'google'} [platformOverride] 指定平台；不传则取 opts.platform 的第一个
 */
export async function checkName(opts, platformOverride) {
  const name = String(opts.name ?? '').trim();
  if (!name) throw new Error('缺少应用名称。用法：node check-name.mjs "<应用名称>" -c us');

  const platform = platformOverride ?? resolvePlatforms(opts.platform)[0];
  const platformLabel = platform === 'google' ? 'Google' : 'Apple';

  const markets = normalizeMarkets(opts.markets);
  if (markets.length === 0) {
    throw new Error(
      '缺少目标市场（-c / --country）。\n' +
      '商店检索结果是按市场分别返回的 —— 同一名称在不同市场的占用情况可以完全不同，\n' +
      '因此必须显式指定目标市场，本脚本不提供默认市场。\n\n' +
      '  单个市场：-c us\n' +
      '  多个市场：-c us,hk,jp\n\n' +
      `常用市场：${MARKET_HELP}`
    );
  }

  const charCount = charLen(name);
  if (charCount > NAME_INPUT_MAX) {
    throw new Error(`应用名称过长（当前 ${charCount} 字符，上限 ${NAME_INPUT_MAX} 字符）。应用商店标题字段本身仅 30 字符，请检查输入内容。`);
  }

  // 逐市场检索。任一个市场失败都不阻断其余市场 —— 交由 storeSearchStatus 如实呈现
  // （多市场部分失败记 'partial'：不得把「查过的市场没有同名」说成「所有市场都没有同名」）。
  // --offline 记 reason 'skipped' 而非 'network_failed' —— 主动不查 ≠ 查失败，
  // 报告措辞必须区分，否则等于把「用户没查」说成「查不出来」。
  // 各市场并发检索 —— 串行时 5 个市场实测 21 秒，且任一市场慢会拖累全部。
  // 并发后总耗时取决于最慢的那个市场，而不是所有市场之和。
  const marketScans = await Promise.all(
    markets.map(async (market) => {
      if (opts.offline) {
        return {
          market: market.toUpperCase(),
          ok: false,
          reason: 'skipped',
          liveStoreMatches: [],
          hasExactMatch: false,
          hasPrefixMatch: false,
        };
      }
      // 进度始终打到 stderr（含平台与市场）—— 让调用方看得到在查什么。
      // stdout 只留给报告 / JSON。
      console.error(`[检索] ${platformLabel} / ${market.toUpperCase()} …`);
      return scanStore({ name, platform, market });
    })
  );

  return evaluateName({
    name,
    platform,
    markets,
    marketScans,
    liveStoreMatches: marketScans.flatMap((s) => s.liveStoreMatches),
    hasExactMatch: marketScans.some((s) => s.hasExactMatch),
    hasPrefixMatch: marketScans.some((s) => s.hasPrefixMatch),
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }

  if (opts.help || !opts.name) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 2);
  }

  let platforms;
  try {
    platforms = resolvePlatforms(opts.platform);
  } catch (err) {
    console.error(String(err.message || err));
    process.exit(2);
  }

  try {
    // 两平台并发跑 —— 请求打到的是不同商店域名（itunes.apple.com / play.google.com），
    // 互不干扰；串行会让多市场场景的等待时间翻倍。
    const results = await Promise.all(platforms.map((p) => checkName(opts, p)));

    if (opts.json) {
      // 始终是数组，一项 = 一个平台。单平台时长度为 1，调用方不必分情况处理。
      console.log(JSON.stringify(results, null, 2));
    } else {
      // 两份报告各自带一级标题，用分隔线隔开即可并列交付，不合并成一份 ——
      // 两平台的裁决彼此独立，硬拼成一张表会把「Apple 锁死、Google 可用」这类
      // 关键差异压平，那层综合判断留给调用方模型做。
      console.log(results.map(renderReport).join('\n\n---\n\n'));
    }

    // 退出码：0 = 无提审阻断，1 = 任一平台存在阻断项。
    // 必须用 overallStatus，不能用 appleVerdict —— 后者只看「同名 / 占位名」，
    // 对促销词与 Emoji 阻断会返回 Clear，且与当前平台无关
    // （Google 平台下同名不算阻断，按 verdict 判会误报 1）。
    process.exit(results.some((r) => r.overallStatus === 'Fail') ? 1 : 0);
  } catch (err) {
    console.error(`检查失败：${String(err.message || err)}`);
    process.exit(2);
  }
}

main();
