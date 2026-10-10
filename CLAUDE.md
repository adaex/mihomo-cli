# CLAUDE.md

本仓开发约定；使用说明见 README，架构决策见 docs/decisions.md，验证结论与边界见 CONCLUSIONS，版本历史见 CHANGELOG。代码注释只写判据与契约，历史叙事不进注释。

## 项目与架构

macOS 命令行客户端，TypeScript ESM，Node.js >= 24.20.0。入口 `src/index.ts`，tsx 开发，tsup 打包。命令入口 `mihomo-cli`（全称）/`mh`（简写），package.json bin 是唯一登记表。

| 模块 | 职责 |
| --- | --- |
| `commands/registry.ts` | 命令、别名、帮助与 argv 改写的唯一登记表 |
| `commands/*.ts` | 命令处理器；shared 提供子命令分发、确认与重启入口 |
| `types.ts` / `constants.ts` / `flags.ts` | 共享类型、默认值与带值选项登记表 |
| `argv.ts` / `format.ts` / `suggest.ts` / `text.ts` | argv 解析、显示格式化、did-you-mean、字符串安全 |
| `kernel-args.ts` | kernel 的 --mirror/--proxy 选项解析与白名单 |
| `settings.ts` | 设置、订阅列表、订阅缓存与原始配置读写 |
| `subscription.ts` | 订阅下载、更新、配置准备与提交 |
| `config.ts` | YAML 解析、覆写与系统配置合并、内核原生校验 |
| `overwrite.ts` | 覆写加载（YAML + JS 脚本）、作用域过滤与合并语法 |
| `runtime.ts` | Mixed 服务与 TUN 临时进程的运行时入口 |
| `service.ts` | 用户级 LaunchAgent 的安装与启停、健康确认；拆出节统一 re-export，导出清单不变 |
| `launchctl.ts` / `stop-epoch.ts` / `hot-reload.ts` | 自 service.ts 拆出：launchctl 解析与状态读取、停止计数与并发基线（D2/D4）、热重载探测与结论 |
| `process-probe.ts` / `process-start.ts` / `process-stop.ts` | 进程探测、TUN 启动、清理与残留分档处置 |
| `kernel.ts` / `http.ts` | 内核下载与有超时、大小限制的 HTTP 客户端 |
| `paths.ts` | 路径、目录、原子写与跨进程锁 |
| `log-files.ts` / `open.ts` | 日志轮转、查询与系统打开操作 |
| `redact.ts` | `config` 展示侧的凭据脱敏：敏感键递归掩码、provider 订阅 URL 复用 maskUrl |
| `system-proxy.ts` | env 自代理判定（isLoopbackHost/proxyEnvPointsAtSelf）与系统代理只读检测、分档提示（不写系统设置） |
| `proxy-probe.ts` / `spinner.ts` / `sudo.ts` | 连通性探测、等待反馈、按需提权 |
| `curl-spawn.ts` | 全仓 curl 子进程代理策略唯一出口：per-spawn env 置空 no_proxy/NO_PROXY 保 -x 权威，三处 spawn（产物下载/release API 查询/连通性探测）共用 |
| `errors.ts` / `utils.ts` / `colors.ts` / `lifecycle.ts` | 错误、杂项（sleep）、颜色、信号处理 |

## 开发与验证

```bash
npm run dev && npm run typecheck && npm test && npm run check && npm run build
```

- Biome 管格式与 import 排序；worktree 里显式 `npx biome check src/` 并确认实际检查了文件，不接受 `Checked 0 files`；`npm run check` 只在 error 级失败，warn 级不拦——别只看退出码
- 测试用 node:test + tsx，命名 `*.spec.ts`；验证行为与数据最终状态，不用实现清单断言代替
- 端到端夹具统一收在 `src/test-support/`，不在各 spec 重抄 spawn 与 env：cli.ts（makeFixture/runCli/readEpochIn/ENTRY，模块级子进程 runModule/moduleUrl，CLI 夹具自带临时 MIHOMO_CLI_DIR + 一次性 label + NO_COLOR 三件套）、fake-kernel.ts（假内核落盘/起进程/等出现/判死/收尾，禁静态 import 模块加载期固化 DIR 的模块）、guard.ts（守卫类 preload spawn 骨架，env 整体替换以表达「刻意不设 DIR」形态）
- 验收命令不接管道收尾（`npm test | tail` 的退出码是 tail 的）：红会被吞成 0，要截断输出就重定向到文件再看
- 修完必做反向验证（还原修复、确认用例转红），规则见 decisions.md D11；预测落空处是认知与实现的偏差点，补不变量用例挡在结构层
- 真实 sudo/TUN 与永久污染 launchd disabled 表的用例不自动执行，理由见 CONCLUSIONS
- 进程类测试必须有隔离断言：临时 `MIHOMO_CLI_DIR`，涉及服务/reset 再加一次性 `MIHOMO_CLI_DAEMON_LABEL`
- 删除或更名导出后全仓搜索（含测试内嵌脚本与 Markdown 示例）；typecheck 看不到字符串里的 import
- 跨进程并发用 spawn 并行验证，spawnSync 顺序跑验不了

## 产品边界（开发判据，用户承诺见 README）

- Mixed 只由用户级 LaunchAgent 托管；TUN 是按需 sudo 的临时进程，CLI 本身不以 root 运行
- 不自动设置系统代理、不提供 proxy on/off；需要代理的应用自行配置 Mixed 端口
- 单活跃订阅；多机场节点用 mihomo 原生 proxy-providers；SSH 出口由用户自行 `ssh -D`
- 注册表只登记当前支持的命令与别名；未知命令/子命令/选项统一报错，不维护旧版本迁移分支
- 破坏性操作需要确认：非 TTY 且无显式跳过选项时报错退出 1，交互拒绝才显示已取消
- reset 流程固定：解析与确认 → 停止或卸载服务 → 清理进程 → 删除目标 → 更新相关设置；确认前不做破坏性操作；删除失败必须报错，成功提示以实际删除为准
- 服务 label 固定 `com.mihomo-cli.daemon`，可用 `MIHOMO_CLI_DAEMON_LABEL` 隔离；label 是持久化注册键，随意改名会遗留无法管理的自启进程

## 用户配置（本机）

- 查/改 mihomo 配置只操作 `~/.mihomo-cli` 下文件：`settings.json`、`overwrite*.yaml`、`overwrite*.mjs`
- 这些文件由 `~/space/dotfiles` 维护（快照 `dots/dot-mihomo-cli.md`）；改完必须 `dot save` 同步回 dotfiles 并在该仓提交，新机恢复用 `dot apply`；`dot save -n` 可先看差异
- 配置文件改坏了从快照还原：`dot apply -n` 先看差异、`dot apply -y` 非交互执行；不要手搓 sed 修文件（多行清理易留残迹，机制还原才是干净基线）
- dotfiles 快照里的说明性注释（各订阅作用域、Seal 出口依赖）改配置时同步更新，不只存文件内容

## 命名

- 帮助与内部命名用全称单数（subscription/directory/overwrite），示例与提示用 `mihomo-cli sub` / `dir` / `ow`；内部变量函数全称单数，常量全大写下划线
- `dir open` 精确匹配 root/subs/logs/data/runtime/kernel

## 关键不变量（跨模块契约，论证见 decisions.md）

**错误与结果**
- 预期错误抛 `CliError` 由 main().catch 统一渲染；再包装前透传已有 CliError；模块顶层不抛 CliError
- 报告成功要有独立结果依据（写入结果/健康/卸载/大小），不能用「命令没报错」代替
- 探测失败 ≠ 目标不存在：launchctl print 只认 113 为未装载，bootout 容忍 3/113（`BOOTOUT_NOT_LOADED_CODES`/`isBootoutNotLoaded` 唯一出处），pgrep/pkill 只收退出码 0/1

**数据与并发**
- `readSettings()` 每次读盘；一致视图由调用方在命令开头取快照显式传递（D4/D10）
- 依赖现值的写入走 `updateSettings(mutator, postCommit?)`：持锁、同步 mutator、写盘成功后才做文件副作用
- 跨进程锁只在数据根目录、以 `Lock` 结尾命名（paths.spec 按约定枚举断言）；会被 rmrf 的目录不放任何有生命周期的文件（锁、stage、epoch）
- 原子写 = 临时文件 + fsync + rename + fsync 父目录；崩溃遗留 `*.tmp` 由守卫之后按龄清扫
- 并发判据唯一：`shouldAbortStartOnDisable`（epoch）与 `describeExitCause`，调用点不散写第二份比较；基线由 main() 捕获为进程状态（D2/D4）

**配置与覆写**
- 入站与控制面锁定的唯一真相是 constants.ts 的 `LOCKED_CONFIG_KEYS` 与实际执行集 `EFFECTIVELY_LOCKED_KEYS`（快照表 + tls）：告警扫描、剥除循环、脚本探针、快照 spec 全派生自它，不许重抄；判据与上游核对方法见 D5，完整性由 `config-inbound-snapshot.spec.ts` 兜底
- 合并闸门唯一出口 `selectActiveOverwriteFiles`；加载双路径（合并硬失败/诊断旁路）见 D7
- 覆写操作符（`key!`/`+key`/`key+`）只在顶层生效；带条件的变换一律写 JS 脚本（`export default (config, ctx) => {}`，契约见 D12/D13：就地修改、必须同步、`return true` 严格 `=== true` 报命中，status 据此区分生效与不适用且只计数不点名——查哪个文件对照 `ow` 列表的作用域栏）；脚本在 YAML 之前、剥锁定键之前执行，改不动系统锁定项；`~`/`~?`/`<x>` 与 match 的 `subscription` 键已移除，写这些形态显式报错，不许静默当字面键
- match 的 name 只支持尾部 `*`（前缀）与头部 `*`（后缀）两种通配，其余报错——不引入通用匹配器（正则转义实现曾有灾难性回溯）；JS 脚本无 match 机制，作用域写在脚本里
- 配置解析只走 YAML（D6）； Mixed 清 tun 字段，TUN 强制 dns.enable=true

**launchd 与进程**
- 改服务代码前读对应函数注释；锁内 launchctl 预算关系由 service-concurrency.spec 断言，新增锁内调用前先改测试（D3）
- 热重载成功不验、kickstart 回退必须健康确认（restartService 返回值语义）
- kill 前逐 pid 复核命令行，复核不匹配按「无事可做」计成功
- TUN 与服务共享 config.yaml，起 TUN 前必须关服务自启，两条方向都有并发防线

**内核下载**
- 镜像只作用产物下载、选择不持久化；版本查询代理可用时直接经代理（D8）
- 守卫前清 env 代理只清指向本机 Mixed 端口的自指形态（D9）；gh 回退与 npm 恢复两个 per-spawn 并存例外的判据与构造见 D9（共同前提「全程不重启内核」，均不写回 process.env）
- 下载候选为列表、逐个尝试首个成功即用；显式 --mirror/--proxy 只有一个候选（显式意图不自动换道）
- curl 子进程代理策略唯一出口是 `curl-spawn.ts` 的 `buildCurlSpawnEnv`：per-spawn env 置空 no_proxy/NO_PROXY 保 `-x` 权威；直连通道的 `--noproxy '*'` 在 args 层（buildKernelCurlArgs），proxy 通道 args 绝不能加 --noproxy；三处 spawn（产物下载/release API 查询/连通性探测）不得另写 env 代理处理

## Git 与流程

- 默认在 `.claude/worktrees/` 工作，创建前 fetch；worktree 里重读待编辑文件
- 不需要 Co-Authored-By；提交后按 `.claude/commands/wt-done.md` 合入 main 并立即清理
- 发布仅在用户要求时执行，按 `.claude/commands/release.md`
- 历史修复叙事留在 CHANGELOG/git，不复制进现行文档
- CHANGELOG 每条 1–3 句：改了什么、用户会看到什么变化、必要时一句根因；按用户可见变化组织、**不按轮次组织**（「第 N 轮审查发现」式叙事写出来的是验证流水，不是升级说明）。当轮验证过程（实测耗时、差分组数、反向验证转红）留在当轮 git 提交；长期有效的结论、边界与教训收编进 CONCLUSIONS 对应节，过时的删掉。主文件超 10 个版本节时把最旧整节**原样**搬进 `docs/changelog/CHANGELOG-archive.md`，不改写
