import { colors } from '../colors.js';
import { buildConfig, dumpYaml, getConfigInfo } from '../config.js';
import { CliError } from '../errors.js';
import { readSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription } from '../subscription.js';
import { assertKnownFlags, assertPositionalCount, hasFlag } from '../utils.js';

/**
 * 展示当前生效的运行配置。只读，不写盘、不校验、不重启。
 *
 * **重新推导而非读 runtime/config.yaml**：那个文件在 stop 时会被 `clearRuntime()` 整个删掉
 * （`reset runtime` 同样），停止状态下读盘只能得到「不存在」——而「停着的时候看看配置对不对」
 * 恰是最需要它的时候。改配置（切订阅、调覆写）后想确认结果，也不必先把服务跑起来。
 *
 * 推导走 `buildConfig`（订阅 + 覆写 + 系统锁定项的纯合并），与 `start` 用的是同一条路径，
 * 故这里看到的就是启动会写进去的内容。**刻意不调 `prepareConfigForStart`**：它会执行内核
 * 原生校验（需要装了内核、要起子进程、还要建临时目录），而这是个只读展示命令——
 * 校验归 `doctor` 和 `start`，各自职责不混。
 *
 * mode 与 status/doctor 同判据：看当前落盘配置里有没有 tun，没有就按 mixed 推导。
 */
export function cmdConfig(args: string[] = []): void {
  assertKnownFlags(args.slice(1), ['-j', '--json'], 'config [--json]');
  // 不接受位置参数：`config garbage` 此前被静默忽略
  assertPositionalCount(args, 0, 1, 'mihomo config [--json]');
  const asJson = hasFlag(args, '-j', '--json');

  const active = getActiveSubscription();
  if (!active) {
    throw new CliError('尚无订阅，无法推导配置', { hint: '添加订阅: mihomo sub add <url>' });
  }

  const rawContent = readSubscriptionRawConfig(active.name);
  if (!rawContent) {
    throw new CliError(`订阅 "${active.name}" 有条目但没有本地配置文件`, { hint: `更新订阅: mihomo sub update ${active.name}` });
  }

  // 与 status/doctor 一致：当前是 TUN 就按 TUN 推导，否则 Mixed
  const mode = getConfigInfo()?.tun ? 'tun' : 'mixed';
  const { config, warnings } = buildConfig(rawContent, mode, { subName: active.name, subUrl: active.url });

  // secret 是凭据，不能明文打印——展示用的副本改掉，不动 config 本体。
  // 不判类型：buildConfig 已保证非字符串 secret 直接报错，这里只要键存在就脱敏，
  // 不把「凭据是否上屏」寄托在类型判断上
  const shown: Record<string, unknown> = { ...config };
  if ('secret' in shown) shown.secret = '***';

  if (asJson) {
    // 配置与 CLI 提示分两个键：warnings 若铺在顶层会顶替配置自身的同名键，
    // 也破坏「config 内容 = start 写入内容」。信封形态与 YAML 出口的「正文 + # 提示段」同构。
    // stdout 始终是单个可整体解析的 JSON；无警告时输出空数组，字段形状稳定
    console.log(JSON.stringify({ config: shown, warnings }, null, 2));
    return;
  }

  console.log(colors.gray(`# 订阅: ${active.name}  模式: ${mode}`));
  console.log(colors.gray('# 由订阅与覆写推导，与 start 写入 runtime/config.yaml 的内容一致'));
  if ('secret' in config) {
    console.log(colors.gray('# secret 已脱敏显示'));
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
