# CLAUDE.md

本仓开发约定与稳定决策；使用说明见 README，验证结论与边界见 CODE_REVIEW，版本历史见 CHANGELOG

## 项目与架构

- macOS 命令行客户端，TypeScript ESM，Node.js >= 22.22.1
- 入口 `src/index.ts`，开发用 tsx，tsup 打包为 `dist/index.js`
- 可执行别名：`mihomo`（推荐）、`mhm`、`mh`、`mihomo-cli`
- 安装、下载、配置与启停统一由 TypeScript CLI 维护

| 模块 | 职责 |
| --- | --- |
| `commands/registry.ts` | 命令、别名、帮助与 argv 改写的唯一登记表 |
| `commands/*.ts` | 命令处理器；shared 提供子命令分发、确认与重启入口 |
| `types.ts` / `constants.ts` / `flags.ts` | 共享类型、默认值与选项登记 |
| `settings.ts` | 设置、订阅列表、订阅缓存与原始配置读写 |
| `subscription.ts` | 订阅下载、更新、配置准备与提交 |
| `config.ts` | YAML/JSON 解析、覆写与系统配置合并、内核原生校验 |
| `overwrite.ts` | 覆写加载、作用域过滤与合并语法 |
| `runtime.ts` | Mixed 服务与 TUN 临时进程的运行时入口 |
| `service.ts` | 用户级 LaunchAgent、健康确认、热重载、遗留 root 服务清理 |
| `process-probe.ts` / `process-start.ts` / `process-stop.ts` | 进程探测、TUN 启动与清理 |
| `kernel.ts` / `http.ts` | 内核下载与有超时、大小限制的 HTTP 客户端 |
| `paths.ts` | 路径、目录、原子写与跨进程锁 |
| `log-files.ts` / `open.ts` | 日志轮转、查询与系统打开操作 |
| `proxy-probe.ts` / `spinner.ts` / `sudo.ts` | 连通性探测、等待反馈、按需提权 |
| `errors.ts` / `utils.ts` / `colors.ts` / `lifecycle.ts` | 错误、纯函数工具、颜色、信号处理 |

## 开发与验证

```bash
npm run dev
npm run typecheck
npm test
npm run check
npm run build
```

- Biome 负责格式与 import 排序：内置模块、第三方、本地模块
- 测试命名 `*.spec.ts`，用 node:test + tsx，无额外测试框架
- `.claude/worktrees/` 被 Biome 的默认扫描排除；在 worktree 显式跑 `npx biome check src/`，确认实际检查了文件，不能接受 `Checked 0 files`
- CI 在 macos-latest 跑 typecheck/check/test/build；package.json 的 darwin 限制会阻止其他平台正常安装
- 测试优先验证行为与数据最终状态，不用针对实现清单的断言代替结果验证
- 能隔离的进程路径用真实系统工具验证；真实 sudo/TUN 与会永久污染 launchd disabled 表的测试不自动执行，理由见 CODE_REVIEW
- 测试隔离前提必须有断言：进程匹配需绑定临时 `MIHOMO_CLI_DIR`；涉及 reset/服务查询时还需隔离 `MIHOMO_CLI_DAEMON_LABEL`，LaunchAgent plist 位于数据目录之外
- 删除或更名导出后，搜索整个仓库，包括测试里的内嵌脚本与工作流示例；类型检查看不到字符串中的 import，也不检查 Markdown 示例

## 产品边界

- Mixed 只由用户级 LaunchAgent 托管（`gui/<uid>`），先 install，再 start；不提供 system 域启动分支
- TUN 是按需 sudo 启动的临时进程，用 stop 清理；CLI 本身不以 root 运行
- 不自动设置全局系统代理，不提供 proxy on/off；需要代理的应用自行配置 Mixed 端口
- 单活跃订阅；多机场节点使用 mihomo 原生 proxy-providers，SSH 出口由用户自行运行 ssh -D，节点测速使用 Web UI
- 注册表只登记当前支持的命令与别名；未知命令、子命令和选项统一报错，不维护旧版本迁移分支
- 仍保留旧 root LaunchDaemon 的识别与清理：它可能有 KeepAlive 并持续抢端口，是活跃资源清理能力
- 服务 label 固定为 `com.mihomo-cli.daemon`，可用 `MIHOMO_CLI_DAEMON_LABEL` 隔离；label 是持久化注册键，随意改名会遗留无法管理的自启进程

## 命名与命令

- 帮助用全称单数（subscription/directory/overwrite），示例与提示用 `mihomo sub` / `dir` / `ow`
- 内部变量和函数用全称单数，常量用全大写下划线
- `dir open` 精确匹配 root/subs/logs/data/runtime/kernel
- `FLAGS` 是带值选项与 start 选项的登记表，派生 `VALUE_FLAGS` 和重启透传集合；普通布尔选项不必登记
- `--mirror` 值可选，由 `parseMirrorArg` 单独解析；布尔开关不接受 `=value` 或附加字符
- `dispatchSubcommand` 必须 await/返回 Promise，无子命令走 fallback，未知子命令走必填的 onUnknown
- `config` 命令重新推导而非读 runtime/config.yaml（停止时那个文件会被删掉），走 `buildConfig` 不走带内核校验的 `prepareConfigForStart`；展示前脱敏 secret
- 补全卸载是安装的逆操作：bash 共享文件只剥标记块，zsh/fish 独占文件名但删前必须确认是本工具产物；三个 shell 的 `install`/`uninstall` 词表要同步

## 错误与操作结果

- 预期错误抛 `CliError`，由 index 的 main().catch 统一渲染；命令层不直接 console.error + process.exit
- 再包装错误前先透传已有 CliError，避免标签重复；模块顶层不抛 CliError，环境变量在使用点校验
- detached/事件回调不得抛 CliError；信号处理与 tail 事件回调是直接 exit 的例外
- Node 版本、平台与非 root 三个守卫都在 ensureDirs 之前执行，共用同一份 help/version 豁免名单；豁免命令连 ensureDirs 也跳过——豁免免掉的是副作用面（不建目录）而不只是「不被拒绝」，按 `command.name` 匹配已覆盖别名与改写 token；Node 下限取自 package.json 的 `engines.node`（只认 `>=x.y.z`，解析不出就跳过检查，不能挡死所有命令）；开发逃生阀为 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1`
- 报告成功应有独立的结果依据：配置提交查写入结果，服务启动查健康，停止查卸载/残留，下载查大小与可执行性
- 内核校验失败的提示附带本次生效的覆写文件与作用域；文案收口在 `buildKernelRejectHint`，空清单时不加该段，调用点不散写文案
- doctor 的失败项透传 `CliError.hint`（`Check.notes`），只取 message 首行会丢掉唯一的排查线索
- `openUrl` 是 detached、返回 void，调用方始终显示地址/路径，供打开失败时手动使用
- 破坏性操作需要确认时，非 TTY 且无显式跳过选项应报错退出 1；交互拒绝才显示已取消
- 改共享判据时检查全部消费者，不能只修第一条路径

## 数据与并发

- `readSettings()` 每次读磁盘；同一操作需一致视图时显式传递快照，不加进程级缓存
- 依赖当前值的写入使用 `updateSettings(mutate)`：持锁读最新、计算补丁、原子写；空补丁不写文件
- `writeSettings` 只用于单键/整值替换，undefined 表示删除键；订阅列表通过 `getSubscriptions(snapshot)` 读取并过滤结构错误
- mutator 必须同步，不得重入 updateSettings/writeSettings；并发测试要用 spawn 并行启动，spawnSync 顺序运行无法验证并发
- settings 损坏先备份 `.bak` 再回退默认值；订阅缓存读改写也必须持锁
- `withFileLock` 接收锁文件路径，锁均在用户数据根目录，命名 `xxxLock`；runtime/subscriptions 等目录会被整体删除，不能放锁
- 锁超过 10s 可强夺；释放时校验 pid+hrtime token，只删除仍归自己的锁
- 进程退出轮询必须 async + sleep，让 SIGINT 能被处理；只有同步文件锁内部等待使用同步睡眠
- URL 按整条处理，不按逗号拆分；展示时脱敏并清除终端控制字符
- `writeFileSync` 的 mode 只在创建时生效；可能已存在的 sudo 脚本需显式 chmod

## 配置与覆写

启动先准备并校验候选配置，通过后原子替换 runtime/config.yaml，再启动或重载内核

- YAML 解析也支持 JSON，不另设 JSON 回退；保留解析器行列号、结构校验与 YAML 别名限制
- 下载内容必须有 proxies/proxy-groups/proxy-providers 中至少一种非空来源，再覆盖本地订阅，避免错误 JSON 覆盖可用配置
- CLI 只做形态检查、显式覆写与系统约束；节点重名、分组/provider 引用和规则语义交给已安装的 mihomo `-t`
- 原生校验用独立 runtime/check-* 临时目录，`-d` 与实际运行使用同一 data 目录；成功和失败都清理候选文件
- 校验失败不得替换现有 config.yaml；doctor 复用准备与校验路径
- 生效的覆写清单随 `BuildConfigResult.overwriteSummaries` 带出并传给内核校验；校验函数内不得自行 `loadOverwriteFile`——那拿不到 scope 会列出未生效的文件，且 match 校验会在错误路径上再抛一条错误盖掉内核原文
- `~key` 未命中即追加是文档与 ssh 出口场景承诺的行为，不能改；「只改已有、不新增」用 `~?key` 表达，跳过时经 warnings 告警（静默跳过与分组名拼错无法区分）
- 不在 CLI 补分组必填字段校验（字段集随内核漂移），残缺元素仍由 mihomo `-t` 拒绝
- 不自动删除节点、分组或规则，不为覆写节点注入 exclude-filter；include-all 和用户写的过滤条件按 mihomo 原生语义生效
- 只持久化最终运行配置；原始订阅保存在 subscriptions，覆写保存在数据根目录
- mixed-port 与 external-controller 由 settings.ports 决定（默认 7890/9090）；端口需为不同的 1–65535 整数
- secret 只取 settings.controller_secret；订阅的独立入站端口（port/socks-port/redir-port/tproxy-port）和 external-ui 字段不进入运行配置
- Mixed 清除 tun 字段；TUN 使用系统 tun 配置并强制 dns.enable=true，显式冲突要提示，其他 DNS 字段尊重用户配置
- DNS 必须是映射，Mixed 与 TUN 共用形态检查；fake-ip 模式未显式配置 sniffer 时补默认嗅探配置
- 覆写主文件先加载，扩展文件按名称排序；match 的 subscription/url-domain 为 AND 条件，订阅名匹配不区分大小写，无 match 全局应用，非法或空 match 报错
- `key!` 整体覆盖，`+key`/`key+` 数组插入，`~key` 按 name 合并（未命中追加）、`~?key` 按 name 合并但未命中忽略，`<+key>` 转义；数组操作遇到已存在的非数组值应报错
- 覆写默认开启；applyOverwrite 只接收调用方已筛选的文件，不自行读设置或加载文件

## reset

目标表只存元数据；流程依次为「解析与确认 → 停止或卸载服务 → 清理进程 → 删除目标 → 更新相关设置」

- 确认前不做破坏性操作；先解除服务 KeepAlive 再清理内核，未能停止则中止删除
- 目标顺序不影响结果；包含 settings 时删完不写回，部分重置仅删除相关设置键
- 裸 reset 保留 kernel/overwrites/settings/service 目标；清除订阅时同步清订阅列表与当前选择
- reset overwrites 恢复默认开启；即使文件不存在也要处理开关
- reset kernel 停止进程并清掉整个内核目录，包括未完成下载
- 删除失败必须报错，不能记录成成功；成功提示以实际删除或设置变化为准

## launchd 与进程

改服务代码前读对应函数注释，以下系统行为不能按直觉替换

- bootstrap 成功只代表装载，启动需观察完整健康窗口；窗口之后的崩溃由 status/doctor 诊断
- disabled 状态下 bootstrap 硬失败，必须先 enable；disabled 位持久化在 plist 之外，uninstall 保留它
- 并发 start/stop 以 service-stop-epoch 的变化判断；快照由命令层取（不晚于本命令赖以决策的第一次观察），经参数透传，startService/restartService/installService 在 service.lock 内复读，健康确认失败后再复读一次
- 当前 disable 位无法表示停止事件：上次 stop 和本次并发 stop 都可能是 true；递增只在「已确认不会自启且无内核在跑」之后，证据可以是复核过的 disable，也可以是读到的状态本身（`recordServiceStopped`），两者强度相同，都必须放在该路径最后一道失败检查之后
- 同步 service.lock 临界区不跨异步等待，bootout 后通过 waitUntilUnloaded 轮询确认；kickstart 的 60s 超时远超锁的 10s 强夺阈值，必须留在锁外
- 并发防线的消费点不止锁内：bootstrap 到健康确认有 1.2–3s 完全在锁外，那里也要判一次。递增点同理——「有 disable 动作」的收口盖不住「没 disable 可做但已确认停止」的路径（v4.7.5→4.7.7 连修三版仍留六处缺口，每次都只补了当时那条）。透传快照的参数一律必填，可选默认值会让新调用方静默退化
- launchctl print 仅 113 表示未装载，112/125 是查询失败；bootout 对未装载目标返回 3
- 退出码与 terminating signal 互斥；统一用 describeExitCause，status/doctor/启动失败共享判据
- launchctl print 顶层字段以单 tab 开头，嵌套字段双 tab，解析锚定行首
- TUN 与服务共享 config.yaml，启动 TUN 前关闭服务自启；startService 拒绝 TUN 配置，恢复 Mixed 由显式 start 完成
- 进程命令行保留启动时路径，匹配需兼顾 mihomo 与 mihomo-cli-service 符号链
- pgrep/pkill 使用 POSIX ERE，不支持 `(?:...)` 等 JS 正则；退出码仅接受 0/1，其他情况报错
- BSD ps 读取 command 列必须带 -ww，否则路径可能截断；kill -0 不能区分僵尸进程，TUN 判活还需进程状态与完整观察窗口
- 日志 rename 只在旧进程退出、新进程未起的窗口使用；运行中轮转用 copy-truncate
- 归档命名与判据统一用 allocateArchivePath/isArchiveLogFilename，支持同秒序号后缀

## 内核下载

- 默认通道 gh > 本机代理 > 直连；显式 --mirror 或 --mirror direct 优先，选择不持久化
- MIRROR_HOST/MIRROR_ALIASES 派生展示清单；默认镜像依本机 IPv6 情况选择
- GitHub API 不经过镜像，代理只是 TLS 传输层；assertTrustedAssetUrl 在拼镜像前缀之前校验原始地址
- gh 按精确资产名下载，拒绝 glob 元字符与路径成分
- curl 强制初始与重定向全链路 HTTPS，有大小上限，下载后比对 asset.size，再用 -v 自检
- 优先精确匹配标准版资产形态；没有标准版时可选匹配架构的其他资产，但 release 全是预发布时不回退
- tar 同时检查路径与条目类型，拒绝符号链/硬链，遍历用 lstat；上游未提供校验和时主要依赖来源约束

## 数据目录

默认 `~/.mihomo-cli`，可用 MIHOMO_CLI_DIR 自定义

```text
settings.json / settings.json.bak
settings.lock / subscription-cache.lock / service.lock
service-stop-epoch
overwrite.yaml / overwrite.*.yaml
subscriptions/          # 原始订阅与 cache.json
kernel/                 # mihomo 与 mihomo-cli-service 相对符号链
logs/                   # 当前日志与归档
data/                   # 内核数据、provider 与 GeoIP 等缓存
runtime/                # config.yaml、TUN pid 与操作期间的临时文件
```

符号链用于系统登录项显示，install/start 幂等重建；服务 plist 位于 `~/Library/LaunchAgents`，遗留 root plist 位于 `/Library/LaunchDaemons`

## Git 与流程

- 默认在 `.claude/worktrees/` 工作，创建前 fetch，开始前把本地 main 的未推送提交 ff 合入工作分支
- 进入 worktree 后重新读取待编辑文件，避免沿用主目录的陈旧内容
- 不需要 Co-Authored-By；提交后按 `.claude/commands/wt-done.md` 合入 main 并立即清理 worktree、分支、临时目录与进程
- 合并保留双方仍有效的实测结论；纯历史修复叙事留在 CHANGELOG/git，不复制到多份现行文档
- 发布仅在用户要求时执行，按 `.claude/commands/release.md` 验证、构建、自检产物与发布
