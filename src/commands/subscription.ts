import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import * as runtime from '../runtime.js';
import { addSubscription, getSubscriptions, getSubscriptionsWithCache, removeSubscription, setDefaultSubscription } from '../settings.js';
import { withSpinner } from '../spinner.js';
import * as subscription from '../subscription.js';
import { formatDate, formatRelativeTime, formatTimestamp, formatTraffic, getNonFlagArg, hasFlag, suggestSimilar } from '../utils.js';
import { confirmOrThrow, dispatchSubcommand, restartToApply, type SubCommand } from './shared.js';

/** 订阅内容更新后，运行中的实例仍用旧配置，提示重启生效 */
function printRestartHintIfRunning(): void {
  if (runtime.getRunningState().running) {
    console.log(colors.yellow('提示: 运行中的实例仍使用旧配置，执行 mihomo start 使更新生效'));
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
  console.log('');
  console.log('切换订阅: mihomo sub use <name>');
  console.log('新增订阅: mihomo sub add <url> [name]');
  console.log('更新订阅: mihomo sub update [name]');
  console.log('删除订阅: mihomo sub remove <name>');
  console.log('');
}

/**
 * 拒绝以 `-` 开头的名字。`SAFE_NAME_RE` 允许短横线（`my-sub` 是正常名字），
 * 但**以短横线开头**的名字会造出删不掉的订阅：add/use/update 用位置参数能建出 `-s`，
 * 而 remove 走 getNonFlagArg 会把 `-s` 当选项跳过，恒报「请指定名称」，`-y` 也无用。
 * 与其让两边口径打架，不如在入口就拒绝这种名字。
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
  const url = args[2]?.trim();
  const name = args[3] || 'default';

  if (!url) {
    throw new CliError('请提供有效的订阅 URL');
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
  printSubscriptionList();
}

async function subUpdate(args: string[]): Promise<void> {
  const name = args[2];
  const subs = getSubscriptions();

  if (subs.length === 0) {
    throw new CliError('没有订阅');
  }

  if (!name) {
    console.log(`更新所有 ${subs.length} 个订阅...`);
    const results = await withSpinner('并行更新中', () => Promise.all(subs.map(sub => subscription.tryUpdateOne(sub))));
    let ok = 0;
    for (const r of results) {
      if (r.success) ok++;
      subscription.printUpdateResult(r);
    }
    // 各条结果已逐条打印；全部失败时以非零码收尾（无额外信息，故 hint 留空）
    if (ok === 0) throw new CliError('全部订阅更新失败');
    console.log('');
    printRestartHintIfRunning();
    printSubscriptionList();
    return;
  }

  const target = subscription.resolveSubscription(subs, name);

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
  const name = args[2];
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
  // 用 getNonFlagArg 而非 args[2]：允许 -y 出现在名称之前（`sub remove -y foo`）
  const name = getNonFlagArg(args, 2);
  const subs = getSubscriptions();

  if (!name) {
    throw new CliError('请指定要删除的订阅名称', {
      hint: subs.length > 0 ? ['', '可用订阅:', ...subs.map(s => `  ${s.name}`)] : undefined,
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
  }

  console.log('');
  printSubscriptionList();
}

// list 刻意不注册：裸 `sub` 就是列表（fallback），与 `dir` / `ow` 同口径。
// v3.11.0 已删掉 `dir list` / `ow list`，若这里保留 `sub list`，同一批命令
// 一半能敲 list 一半不能，用户只能靠试。
export const SUBCOMMANDS: SubCommand[] = [
  { name: 'add', description: '添加订阅', handler: subAdd },
  { name: 'update', description: '更新订阅', handler: subUpdate },
  { name: 'use', description: '切换订阅', handler: subUse },
  { name: 'remove', aliases: ['rm', 'delete'], description: '删除订阅', handler: subRemove },
];

export async function cmdSubscription(args: string[]): Promise<void> {
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无子命令 → 列表；未知子命令 → 报错
    fallback: printSubscriptionList,
    onUnknown: action => {
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的订阅命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '用法: mihomo sub [use|add|update|remove]（裸 sub 即列表）'],
      });
    },
  });
}
