import { assertKnownFlags, assertPositionalCount, hasFlag } from '../argv.js';
import { colors } from '../colors.js';
import { buildConfig, deriveRuntimeMode, dumpYaml, getConfigInfo } from '../config.js';
import { assertConfigGraphExpansionSafe } from '../config-graph.js';
import { redactConfigSecrets } from '../redact.js';
import { requireSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription, noSubscriptionsError } from '../subscription.js';

/**
 * 展示按当前订阅缓存、覆写与设置重新推导的配置预览。不写盘、不校验、不重启。
 *
 * 不直接读 runtime/config.yaml：stop/reset runtime 会删除它，停止时也需要预览；
 * 修改订阅或覆写后，预览展示的是候选配置，不代表运行中的内核已经应用。
 *
 * buildConfig 与 start 共用合并路径，但 start 可能先自动更新订阅，JS 脚本也可非确定，
 * 故不承诺预览等于下一次 start 的写入结果。刻意不调 prepareConfigForStart：
 * 内核原生校验归 doctor/start，预览不要求安装内核。
 *
 * mode 与 status/doctor 同判据：看当前落盘配置里有没有 tun，没有就按 mixed 推导。
 */
export function cmdConfig(args: string[] = []): void {
  assertKnownFlags(args.slice(1), ['-j', '--json', '--reveal'], 'config [--json] [--reveal]');
  assertPositionalCount(args, 0, 1, 'mihomo-cli config [--json] [--reveal]');
  const asJson = hasFlag(args, '-j', '--json');
  const reveal = hasFlag(args, '--reveal');

  const active = getActiveSubscription();
  if (!active) {
    throw noSubscriptionsError();
  }

  const rawContent = requireSubscriptionRawConfig(active.name);

  // 与 status/doctor 一致：当前是 TUN 就按 TUN 推导，否则 Mixed
  const mode = deriveRuntimeMode(getConfigInfo());
  const { config, warnings } = buildConfig(rawContent, mode, { subName: active.name, subUrl: active.url });

  // reveal 绕过脱敏副本，JSON 出口必须单独执行同一展开预算；YAML reveal 保留共享图，无需展开
  if (asJson && reveal) assertConfigGraphExpansionSafe(config);

  // 默认凭据脱敏：顶层 secret 之外，节点的 password/uuid/private-key/auth-str 与
  // provider 订阅 URL 里的 token 同样是凭据，明文铺满整屏（录屏、| pbcopy 求助）即泄漏。
  // --reveal 显式查看原文。脱敏在展示副本上做，config 本体不动
  const redacted = reveal ? { config, changed: false } : redactConfigSecrets(config);
  const shown = redacted.config as Record<string, unknown>;

  if (asJson) {
    // 配置与 CLI 提示分两个键：warnings 若铺在顶层会顶替配置自身的同名键。
    // 信封形态与 YAML 出口的「正文 + # 提示段」同构
    // stdout 始终是单个可整体解析的 JSON；无警告时输出空数组，字段形状稳定
    console.log(JSON.stringify({ config: shown, warnings, redacted: !reveal && redacted.changed }, null, 2));
    return;
  }

  console.log(colors.gray(`# 订阅: ${active.name}  模式: ${mode}`));
  console.log(colors.gray('# 配置预览：未写盘、未校验、未应用'));
  if (!reveal && redacted.changed) {
    console.log(colors.gray('# 凭据已脱敏显示，--reveal 可查看原文'));
  }
  console.log('');
  console.log(dumpYaml(shown).trimEnd());

  // 警告走 stderr 之外的独立段落：合并时的系统锁定项冲突提示对排查很关键，
  // 但不能混进 YAML 正文里——否则管到别处就成了非法配置
  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) console.log(colors.yellow(`# ${w}`));
  }
}
