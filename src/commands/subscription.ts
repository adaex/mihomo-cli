import { spawnSync } from 'node:child_process';

import { assertKnownFlags, assertPositionalCount, assertRestartOptionValues, getNonFlagArg, hasFlag } from '../argv.js';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { START_RESTART_FLAGS } from '../flags.js';
import { formatDate, formatRelativeTime, formatTimestamp, formatTraffic } from '../format.js';
import * as runtime from '../runtime.js';
import { addSubscription, getSubscriptions, getSubscriptionsWithCache, maskUrl, removeSubscription, setDefaultSubscription } from '../settings.js';
import { withSpinner } from '../spinner.js';
import * as subscription from '../subscription.js';
import { suggestSimilar } from '../suggest.js';
import { confirmOrThrow, confirmPrompt, dispatchSubcommand, restartToApply, type SubCommand } from './shared.js';

/** 订阅内容更新后，运行中的实例仍用旧配置，提示重启生效。
 * 提示的命令须与 restartToApply 选出的重启模式一致：TUN 在跑时裸 start 默认 Mixed，
 * 用户照提示执行会把全局路由静默切走——与「配置变更按原模式重启」是同一判据的两面。
 * variant：变更形态。remove 删除当前订阅时运行中的内核还在服务**已删除订阅**的配置、
 * 当前订阅已静默切走，用户看到「已自动切换到 X」会误以为代理已在用 X——必须提示，
 * 复用这里同一重启命令判据，不另写一份 */
function printRestartHintIfRunning(variant: 'update' | 'removed-active' = 'update'): void {
  const state = runtime.getRunningState();
  if (state.running) {
    const hintCommand = state.kind === 'tun' ? 'mihomo start tun' : 'mihomo start';
    const message =
      variant === 'removed-active'
        ? `提示: 运行中的实例仍在使用已删除订阅的配置，执行 ${hintCommand} 切换到新订阅`
        : `提示: 运行中的实例仍使用旧配置，执行 ${hintCommand} 使更新生效`;
    console.log(colors.yellow(message));
    console.log('');
  }
}

/** 纯只读列表：不触发自动更新（更新是写操作，交给 start 与显式 sub update） */
function printSubscriptionList(): void {
  const subs = getSubscriptionsWithCache();
  if (subs.length === 0) {
    console.log('没有订阅');
    console.log('');
    console.log('添加订阅: mihomo sub add <url> [name]');
    console.log('');
    return;
  }
  const activeSub = subscription.getActiveSubscription();
  console.log(colors.cyan('订阅列表:'));
  subs.forEach((s, i) => {
    const rel = formatRelativeTime(s.updated_at);
    const time = rel ? `${formatDate(s.updated_at)}（${rel}）` : formatDate(s.updated_at);
    const defaultMark = activeSub && s.name === activeSub.name ? colors.green(' [使用中]') : '';
    const interval = subscription.resolveUpdateInterval(s.update_interval);
    console.log(`  ${i + 1}. ${s.name}${defaultMark}`);
    console.log(`    ${colors.gray('更新: ')}${time} (间隔: ${interval}h)`);

    if (s.username) {
      console.log(`    ${colors.gray('用户: ')}${s.username}`);
    }
    const traffic = formatTraffic(s.upload, s.download, s.total);
    if (traffic) {
      console.log(`    ${colors.gray('流量: ')}${traffic}`);
    }
    if (s.expire !== undefined) {
      console.log(`    ${colors.gray('到期: ')}${formatTimestamp(s.expire)}`);
    }
    if (s.web_page_url) {
      console.log(`    ${colors.gray('页面: ')}${s.web_page_url}`);
    }
  });
  // 全部订阅都没有流量数据、且至少一个从未更新过时点一句：流量与到期是列表的常驻
  // 展示项，静默缺行用户无从知道只差一次 update。加了后一个条件——有的机场根本不下发
  // Subscription-Userinfo，刚 update 完仍无数据；这种「更新过却没数据」再提示会让用户
  // 反复 update 并怀疑工具坏了（列表面板不能被坏状态击穿，只提示）
  if (subs.some(s => s.updated_at == null) && subs.every(s => formatTraffic(s.upload, s.download, s.total) === null)) {
    console.log(colors.gray('提示: 更新订阅后可显示流量与到期信息（mihomo sub update；机场不下发用量数据则无此信息）'));
  }
  console.log('');
  console.log('切换订阅: mihomo sub use <name>');
  console.log('新增订阅: mihomo sub add <url> [name]');
  console.log('更新订阅: mihomo sub update [name]');
  console.log('删除订阅: mihomo sub remove <name>');
  console.log('');
}

/**
 * 读剪贴板取订阅 URL（macOS pbpaste）；非 TTY / 读取失败 / 非 URL 一律返回 null。
 * 取整串 trim 后整体校验，不猜「多行内容里哪一行是 URL」——猜错的代价是把
 * 错误内容当订阅写盘。展示走 maskUrl，确认前不回显完整链接
 */
function readUrlFromClipboard(): string | null {
  if (!process.stdin.isTTY) return null;
  try {
    const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 3_000 });
    if (r.status !== 0) return null;
    const text = (r.stdout || '').trim();
    return subscription.isValidHttpUrl(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * 拒绝以 `-` 开头的订阅名。`SAFE_NAME_RE` 允许短横线（`my-sub` 是正常名字），
 * 但以 `-` 开头的名字会造出后续命令无法指定的订阅：remove/use/update 都走
 * getNonFlagArg 取名称，`-` 开头的 token 一律按选项跳过，恒报「请指定名称」，
 * 只剩 reset 能收拾。裸 `-` 还逃过未知选项拦截（argv 解析显式豁免它），
 * `sub add <url> -` 能真的建出这种名字——必须在入口拒绝
 */
function assertNotFlagLike(name: string, usage: string): void {
  if (name.startsWith('-')) {
    throw new CliError(`名称不能以 "-" 开头: "${name}"`, {
      label: '参数错误',
      hint: ['以 "-" 开头的名称会与命令行选项混淆，删除时无法指定。', `用法: ${usage}`],
    });
  }
}

async function subAdd(args: string[]): Promise<void> {
  // url 与可选 name 至多两个：`sub add <url> <name> extra` 此前静默忽略 extra；
  // 校验先于入库/下载，避免半成品副作用
  assertPositionalCount(args, 2, 2, 'mihomo sub add <url> [name]');
  let url = args[2]?.trim();
  // 空串按显式提供处理并报错，而非静默落到 'default'——同仓其他命令（ui/dir open/
  // sub update）对空串位置参数一律报错，这里是对齐；静默改名会让「想传名字但传了空」
  // 的用户找不到自己的订阅
  const name = args[3] === undefined ? 'default' : args[3];
  if (!name.trim()) {
    throw new CliError('订阅名不能为空', { hint: '不指定名称时省略该参数即可（默认名 default）' });
  }

  if (!url) {
    // 高频流程是「机场页面点复制 → 终端粘贴」：交互下剪贴板里往往就是订阅链接，
    // 直接读出来确认比让用户重打一遍命令再粘贴顺手
    const clipped = readUrlFromClipboard();
    if (clipped) {
      console.log('未提供 URL，从剪贴板读取到:');
      console.log(`  ${maskUrl(clipped)}`);
      if (!(await confirmPrompt(`添加为订阅 "${name}"?`))) {
        console.log('已取消');
        return;
      }
      url = clipped;
    } else if (process.stdin.isTTY) {
      throw new CliError('剪贴板中没有有效的订阅 URL', {
        hint: ['先复制订阅链接后重试，或显式传入:', '  mihomo sub add <url> [name]'],
      });
    } else {
      throw new CliError('请提供有效的订阅 URL', { hint: ['用法: mihomo sub add <url> [name]'] });
    }
  }

  if (!subscription.isValidHttpUrl(url)) {
    throw new CliError('请提供有效的订阅 URL（需以 http:// 或 https:// 开头）');
  }
  assertNotFlagLike(name, 'mihomo sub add <url> [name]');
  console.log(`添加订阅: ${name}`);
  // 入库（重名/名称非法）在 try 外抛出：回滚只针对「入库成功后下载失败」，
  // 否则重名错误会触发 removeSubscription 误删用户既有的同名订阅
  addSubscription(url, name);
  try {
    const info = await withSpinner('下载订阅', () => subscription.downloadSubscription(url, name));
    // 切换放在下载成功后：若放在前面，回滚的 removeSubscription 会把 active 落到 subs[0]
    // 而非用户原来的选择（settings.ts 的 active 兜底逻辑），静默切错订阅
    setDefaultSubscription(name);
    console.log(`已添加并切换到 "${name}" (${subscription.formatProxySummary(info)})`);
  } catch (e) {
    // 下载失败回滚：不留"已入库但无配置"的半成品订阅（否则 start 会直接报错）
    removeSubscription(name);
    // 保留原 CliError 的 hint（如订阅无效时服务端返回的原因），仅换标签
    if (e instanceof CliError) throw new CliError(e.message, { label: '添加失败', hint: e.hint });
    throw new CliError((e as Error).message, { label: '添加失败' });
  }
  console.log('');
  printRestartHintIfRunning();
  printSubscriptionList();
}

async function subUpdate(args: string[]): Promise<void> {
  // 名称至多一个：`sub update foo bar` 此前静默忽略 bar
  assertPositionalCount(args, 1, 2, 'mihomo sub update [name]');
  const nameArg = getNonFlagArg(args, 2);
  const subs = getSubscriptions();

  if (subs.length === 0) {
    throw new CliError('没有订阅');
  }

  // 区分「无参数」（更新所有）与「空串参数」（`sub update ""`，变量展开为空的常见笔误），
  // 后者此前静默更新所有订阅
  if (nameArg === '') {
    throw new CliError('请指定订阅名称', { hint: ['更新所有订阅直接执行: mihomo sub update', `更新指定订阅: mihomo sub update <名称>`] });
  }

  if (nameArg === null) {
    console.log(`更新所有 ${subs.length} 个订阅...`);
    const results = await withSpinner('并行更新中', () => Promise.all(subs.map(sub => subscription.tryUpdateOne(sub))));
    let ok = 0;
    for (const r of results) {
      if (r.success) ok++;
      subscription.printUpdateResult(r);
    }
    const failedResults = results.filter(r => !r.success);
    console.log('');
    if (failedResults.length > 0) {
      console.log(colors.yellow(`更新完成: ${ok} 个成功，${failedResults.length} 个失败`));
    }
    printRestartHintIfRunning();
    printSubscriptionList();
    // 部分失败也要非零退出：此前 2/3 成功时退出 0，脚本与「更新过了」的用户都发现不了
    // 那条失败；逐条原因已在上面打印，hint 只给逐条重试命令
    if (failedResults.length > 0) {
      const allFailed = failedResults.length === results.length;
      throw new CliError(allFailed ? '全部订阅更新失败' : `${failedResults.length} 个订阅更新失败: ${failedResults.map(r => r.name).join('、')}`, {
        hint: failedResults.map(r => `重试: mihomo sub update ${r.name}`),
      });
    }
    return;
  }

  const target = subscription.resolveSubscription(subs, nameArg);

  console.log(`更新订阅: ${target.name}`);
  const result = await withSpinner('下载订阅', () => subscription.tryUpdateOne(target));
  if (!result.success) {
    throw new CliError((result.error || '').split('\n')[0], { label: '更新失败' });
  }
  console.log(`已更新 (${subscription.formatProxySummary(result)})`);
  console.log('');
  printRestartHintIfRunning();
  printSubscriptionList();
}

async function subUse(args: string[]): Promise<void> {
  // 名称至多一个：`sub use foo bar` 此前静默忽略 bar；带值选项的值（-u 5000）不算位置参数
  assertPositionalCount(args, 1, 2, 'mihomo sub use <name>');
  // 即使未在运行、不触发重启，-u 缺值/非法值也在此刻报错，不静默吞掉
  assertRestartOptionValues(args);
  const name = getNonFlagArg(args, 2);
  const subs = getSubscriptions();

  if (subs.length === 0) {
    throw new CliError('没有订阅，请先添加订阅', { hint: 'mihomo sub add <url> [name]' });
  }

  if (!name) {
    throw new CliError('请指定订阅名称', {
      hint: ['', '可用订阅:', ...subs.map(s => `  ${s.name}`)],
    });
  }

  const target = subscription.resolveSubscription(subs, name);

  const currentDefault = subscription.getActiveSubscription();
  const isAlreadyDefault = currentDefault && currentDefault.name === target.name;

  if (isAlreadyDefault) {
    console.log(`"${target.name}" 已是当前使用的订阅`);
    console.log('');
    printSubscriptionList();
    return;
  }

  const success = setDefaultSubscription(target.name);
  if (!success) {
    throw new CliError(`未找到订阅 "${name}"`);
  }
  console.log(`已切换到 "${target.name}"`);

  // 运行中(服务或 TUN)才重启使新订阅生效；透传用户显式的启动选项(-s/-u 等)
  if (await restartToApply(args)) return;

  console.log('');
  printSubscriptionList();
}

async function subRemove(args: string[]): Promise<void> {
  // 名称至多一个：`sub remove foo bar` 此前静默忽略 bar
  assertPositionalCount(args, 1, 2, 'mihomo sub remove <name>');
  // 用 getNonFlagArg 而非 args[2]：允许 -y 出现在名称之前（`sub remove -y foo`）
  const name = getNonFlagArg(args, 2);
  const subs = getSubscriptions();

  // 与 use/update 同口径：零订阅先报「没有订阅」——环境里没有订阅时，
  // 「请指定名称」会把用户引去补一个不存在的参数
  if (subs.length === 0) {
    throw new CliError('没有订阅，请先添加订阅', { hint: 'mihomo sub add <url> [name]' });
  }

  if (!name) {
    throw new CliError('请指定要删除的订阅名称', {
      hint: ['', '可用订阅:', ...subs.map(s => `  ${s.name}`)],
    });
  }

  const target = subscription.resolveSubscription(subs, name);

  // 删除不可恢复（订阅条目 + 原始配置 + 缓存），而 resolveSubscription 接受子串模糊匹配：
  // `sub remove air` 会命中 production-airport。精确同名视为用户意图明确，直接删；
  // 模糊命中时先展示将删除的完整名称并要求确认（-y/--yes 跳过，供脚本使用）
  const isExact = target.name === name;
  const skipConfirm = hasFlag(args, '-y', '--yes');
  if (!isExact && !skipConfirm) {
    console.log(`将删除订阅 "${target.name}" (模糊匹配 "${name}")`);
    if (
      !(await confirmOrThrow('此操作不可恢复，确认?', {
        nonTtyMessage: `模糊匹配到 "${target.name}"，非交互环境需确认`,
        hint: [`请用完整名称: mihomo sub remove ${target.name}`, `或跳过确认: mihomo sub remove ${name} -y`],
      }))
    ) {
      console.log('已取消');
      return;
    }
  }

  const switchedTo = removeSubscription(target.name);
  console.log(`已删除订阅 "${target.name}"`);
  if (switchedTo) {
    console.log(`已自动切换到 "${switchedTo}"`);
    // 删的是当前订阅：运行中的内核仍在服务已删除订阅的旧配置（add/update 同款缺口）
    printRestartHintIfRunning('removed-active');
  }

  console.log('');
  printSubscriptionList();
}

/** use 放行的选项 = 重启透传集合（restartToApply → extractStartOptions 只认这些），从 flags.ts 单表派生，不手写第二份清单 */
const USE_FLAGS: readonly string[] = START_RESTART_FLAGS.flatMap(f => f.forms);

/** remove 只消费 -y/--yes：模糊匹配删除时跳过确认 */
const REMOVE_FLAGS: readonly string[] = ['-y', '--yes'];

/**
 * 把选项校验包进子命令 handler：分发命中后先按**该子命令**的白名单校验再执行。
 * 白名单必须只含 handler 真正消费的选项——挂在分发前对全组放行时，
 * `sub add <url> <name> -y` 被接受但 add 根本不读 -y（选项被静默忽略），
 * 正是 assertKnownFlags 要防的「用户以为选项生效了，实际行为完全没变」。
 * add/update 不消费任何选项，白名单为空。
 */
function withKnownFlags(usage: string, known: readonly string[], handler: (args: string[]) => void | Promise<void>): (args: string[]) => Promise<void> {
  return async args => {
    assertKnownFlags(args, known, usage);
    await handler(args);
  };
}

// list 刻意不注册：裸 `sub` 就是列表（fallback），与 `dir` / `ow` 同口径——
// 同一批命令一半能敲 list 一半不能，用户只能靠试
export const SUBCOMMANDS: SubCommand[] = [
  { name: 'add', handler: withKnownFlags('sub add <url> [name]', [], subAdd) },
  { name: 'update', handler: withKnownFlags('sub update [name]', [], subUpdate) },
  { name: 'use', handler: withKnownFlags('sub use <name>', USE_FLAGS, subUse) },
  { name: 'remove', aliases: ['rm', 'delete'], handler: withKnownFlags('sub remove <name>', REMOVE_FLAGS, subRemove) },
];

export async function cmdSubscription(args: string[]): Promise<void> {
  // 选项校验已随白名单下沉到各子命令（见 SUBCOMMANDS / withKnownFlags），
  // 分发后按实际命中的子命令校验，不再分发前对全组放行同一份白名单
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无子命令 → 列表；未知子命令 → 报错
    fallback: printSubscriptionList,
    onUnknown: action => {
      // 选项出现在子命令位置：裸 sub 是只读列表、不消费任何选项，按未知选项报错
      if (action.startsWith('-')) {
        throw new CliError(`未知的选项: ${action}`, {
          label: '参数错误',
          hint: ['裸 sub 只列出订阅，不接受选项', '', '用法: mihomo sub [use|add|update|remove]（裸 sub 即列表）'],
        });
      }
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的订阅命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '用法: mihomo sub [use|add|update|remove]（裸 sub 即列表）'],
      });
    },
  });
}
