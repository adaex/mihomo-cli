# 代码审查：验证结论与边界

当前审查：2026-09-12，v4.9.2（v4.9.1 的锁定清单复核：补 `ss-config`/`vmess-config`）

本轮起因是复核 v4.9.1 的 CODE_REVIEW 声明本身：文档称锁定键「逐个回上游 General 段核对」，照着上游 `RawConfig`/`config.Inbound` 重新对表时发现 `ss-config`、`vmess-config` 两个入站服务端从未被任何文档、清单或测试提及——不是待定决策，是纯遗漏。它们与已锁的 `tuic-server` 是同一个 `Inbound` 结构体的并列字段，同由 `executor.updateListeners()` 起监听，只因形态是一行 URL 而非映射而被漏看。修 1 项（安全边界），并修正 v4.9.1 文档里两处与事实不符的记述（「待发布」、测试数 596）。单测 603（+4）

上一轮（v4.9.1）在 v4.9.0 发布当天复审：一人通读并发状态机全线（service/runtime/paths/start/stop/reset/install 命令层），三个分模块深审（覆写与配置、命令层、进程下载），重要线索逐条实测或回上游源码核实；收尾时回上游 General 段逐键复查又补出 `tuic-server`/`external-doh-server` 两个入站面，并修正了锁定告警对真实订阅刷屏的自引入回归。修 15 项：入站/控制面安全边界、一条热重载自愈缺口，其余为一致性收口。两条子审查报的缺陷经对照实验排除（pkill 自匹配、见下）。launchd 的真实启停与 TUN 提权流程仍未做真机端到端复测

规则见 CLAUDE，修复历史见 CHANGELOG；本文保留验证方法、仍有效的实测事实与未覆盖风险，改相关代码时同步更新

## 本轮验证（v4.9.2 锁定清单复核）

| 范围 | 验证方式与结论 |
| --- | --- |
| ss-config / vmess-config 锁定 | 实测 `buildConfig`：订阅与覆写（含 `vmess-config!` 操作符形式）提供时均剥除，覆写侧告警带文件名与键名；`allow-lan: false` 与剥除是两套独立机制，单独一条用例锁死「别拿 allow-lan 当兜底」。上游依据逐处核对（v1.19.30）：`config.go` 的 `RawConfig`/`Inbound` 两个结构体里 `ShadowSocksConfig`/`VmessConfig` 与 `TuicServer` 并列；`hub/executor/executor.go:updateListeners()` 对三者各调一次 `ReCreate*`；`listener/shadowsocks/utils.go:ParseSSURL` 与 `sing_vmess` 的 `ParseVmessURL` 把 URL 的 host 直接当 `Listen`，`New()` 里 `strings.Split(config.Listen, ",")` 逐个 bind——**不经过 `genAddr`**，故 `allow-lan`/`bind-address` 对它们无效（那两个只作用于 HTTP/Socks/Redir/TProxy/Mixed）。反向验证：从 `LOCKED_CONFIG_KEYS` 摘掉这两键，恰好 4 条新用例转红、其余全绿 |
| 既有防线回归 | typecheck / 603 测试 / Biome（实际检查 80 个文件）/ build 全绿；v4.9.1 的锁定家族、告警只对覆写、待定入站面三组用例均仍通过 |

---

## v4.9.1 复审验证（历史，结论仍有效）

单测 599（+48），关键新用例在恢复缺陷时均转红（反向验证过）

| 范围 | 验证方式与结论 |
| --- | --- |
| 控制面与入站锁定 | 实测 `buildConfig`：订阅带 `external-controller-tls/-unix/-pipe/-cors/-routing-mark/-doh`、`tuic-server` 与顶层 `tls` 段时全部剥除；订阅侧无锁定 warning（机场订阅普遍带端口段，静默剥除），生效覆写文件含锁定键（含 `+key`/`key!` 形式）才有带文件名的 warning；`listeners`/`tunnels`/`iptables` 现状保留有测试锁死。键名逐个回上游 `MetaCubeX/mihomo` `config/config.go`（General 段）、`listener/config/tunnel.go`（tunnels 含 address 是入站）、`hub/route/server.go`（TLS 需证书、unix/doh 无前提、CORS 作用于主控制器）核对——**但这次核对漏了同段的 `ss-config`/`vmess-config`，v4.9.2 才补上**。反向验证：恢复旧删除清单或恢复订阅侧告警，对应用例即红 |
| 热重载查询失败回退 | PATH 前置计数桩 launchctl（入口 print 成功→热重载 print 退 112→kickstart→健康窗恢复 running）+ 子进程真实模块：查询失败走 kickstart 并健康确认，不再整体失败。反向验证：getServiceStatus 移回 try 外用例即红 |
| 补全指纹 | 临时 HOME 跑真实 CLI：仅含 `#compdef mihomo` 行业首行的第三方补全、fish 只循环 mihomo 的手写文件均拒绝删除；本工具完整指纹正常装卸；XDG_CONFIG_HOME 下安装/卸载同位置。反向验证：恢复弱指纹两条用例即红。zsh/bash 生成脚本经 `zsh -n`/`bash -n`，fish 仍未装 |
| 覆写矛盾操作符 | `+x+`/`~x!`/`~?x!`/`<x>+!`/`~<x>!` 抛 CliError；裸 `+`/`~`/`!`/`~?` 报空键名；`~?key`、`<+key>!`、`+<+key>` 等合法单一操作符不误伤 |
| secret 类型 | 非字符串 controller_secret 在 buildConfig 报「配置错误」；字符串 secret 两个展示出口脱敏；`config --json` 信封 `{config,warnings}` 下用户配置自带的 `warnings` 键不被顶替 |
| 内核下载 | `--fail-with-body` 在 buildKernelCurlArgs 纯函数用例锁定；`parseTarEntrySize` 对 bsdtar（第 5 列）与 GNU tar（owner/group 第 3 列）两种 `-tv` 布局取大小，目录行计 0，超 512MB 上限被调用方拒绝 |
| 命令层口径 | 真实 CLI（隔离目录 + 隔离 label）：`ui ""`/`dir open ""`/`sub update ""` 报错；`ow on -u`/`sub use x -u5s` 未运行也报错；重复 `--mirror` 报错；`ow -s`/`dir -x` 给未知选项文案；resolveUiName 纯函数测大小写归一 |
| 损坏备份 | 子进程真实模块连写两次损坏内容：settings.json 与 cache.json 的 `.bak` 都只保留第一份原件 |
| 既有防线回归 | typecheck/599 测试/Biome/build 全绿；4.9.0 的锁三进程编排、热重载计数复读、TUN 模式重启、sub 白名单等用例全部仍通过 |

**复审实测排除的疑似缺陷**：

- 「`sudo pkill -f <PATTERN>` 匹配自己命令行、杀掉 sudo 父进程」：对照实验证明**不成立**——`escapeRegExp` 把点转义成 `config\.yaml`，进程命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点，恰好坏掉自匹配；把 `\.` 换回 `.` 的对照组立刻自匹配。三个 root 脚本同此结论，当前不加行首锚（未来若改用未转义拼接必须重验）
- 「detached 孙进程可作端到端到达标记」：`spawnSync` 子进程退出过快时，其 detached 的孙进程（如 `open`）可能来不及执行，PATH 桩收不到调用——openUrl 本就是 fire-and-forget（见 open.ts 注释），这类断言要抽纯函数测，不要靠桩文件
- 文件锁 stat→unlink 不复核 inode：仅在等待者被冻结（合盖/换出）叠加系统时钟前跳时可利用，微秒级窗口，接受为已知理论缺口

---

## v4.9.0 深审验证（历史，结论仍有效）

类型检查、551 项测试（+211）、Biome（实际检查 79 个文件）与构建通过；registry 产物拉回实跑（version、紧贴值报错）确认 tarball 完整。**时序用例的负载敏感性已收口**：发布验证时一次与 build 并行的 `npm test` 假失败（持锁时长断言的桩 sleep 贴预算上限，开销在并行负载下膨胀即破阈值）。修法是护栏分工——时序断言只兜「预算内的慢不破阈值」（桩 sleep 2.5s→2.0s，余量 3.8s），「调大单次预算/往锁内加调用」改由常量关系断言承担（调用次数 × 单次预算 < 强夺阈值，反向验证：预算调 4s 精确转红）；并行 build+test 三轮压测全过

| 范围 | 验证方式与结论 |
| --- | --- |
| stop 的提前返回 | commands/stop.spec 用真实 CLI 打隔离目录 + 不存在的 label：该组合天然走「不在运行」分支，一次 launchctl 写操作都不做。断言消费者可见的后果（`shouldAbortStartOnDisable` 判为变了）而非文件内容，并含负向对照（`status` 不得改变计数） |
| 游离内核清理 | 同上文件：真实桩内核（命令行绑定隔离目录）被杀后同样记录；判活以 `ps` 状态列为准，不用 `kill -0`（僵尸进程会骗过它） |
| reset 的边界 | commands/reset.spec 补一条：`needsStop` 为真的 `reset logs` 记录停止，纯配置的 `reset ow` 不记录 |
| 测试有效性 | 临时注掉两处 `recordServiceStopped` 复核，两条用例即转红，确认不是恒真断言 |
| Node 版本守卫 | commands/node-guard.spec 伪造 `process.versions.node` 跑真实入口（真装旧 Node 连 tsx 都未必起得来，反而测不到守卫）：四个命令被拒且退出非 0、help/version 豁免、被拒时不留数据目录、满足下限时放行 |
| 补全装卸 | commands/completion-install.spec 把 HOME 指向临时目录跑真实装卸，断言文件最终内容：bash 卸载后用户自有内容完好且标记块消失、反复装卸不留空文件、非本工具产物拒绝删除且文件仍在 |
| config 命令 | commands/config.spec 全部在没有 runtime/config.yaml 的目录里跑（锁住「重新推导」这一性质）；输出经 js-yaml 实际解析确认是合法 YAML，secret 已脱敏，`--json` 同样脱敏且携带 `warnings`（空时为数组） |
| 补全脚本语法 | 生成的 zsh/bash 脚本经 `zsh -n`/`bash -n` 校验；fish 未装，未校验 |
| 配置构建 | config/config-dns/overwrite 测试验证 JSON/YAML、形态错误、覆写 DSL、作用域与 TUN DNS；节点、分组和规则不再被隐式修复；`~?key` 未命中即跳过并告警（反向验证：短路成追加后精确三条转红）；覆写操作符只在顶层生效、嵌套键一律字面（反向验证：恢复内层 DSL 解析后通配键/告警用例共九条转红），校验失败提示的覆写清单按作用域过滤、文案逐行锁定；订阅自带 port/socks-port/redir-port/tproxy-port/secret/external-ui 被剥掉、生效值取 settings；fake-ip 注入 sniffer 的判据是合并后 dns 的 enhanced-mode（mixed + 订阅 fake-ip 也注入），`sniffer: null` 不注入（内核把 null 解码为零值，-t 不拒） |
| 原生配置校验 | mihomo v1.19.30 在临时目录执行 -t：Mixed/TUN 合法配置通过；缺失节点、规则目标、重复节点名和缺失 provider 被拒绝；拒绝后旧 config.yaml 保留、候选文件清理 |
| 配置提交协议 | subscription-prepare.spec 用隔离桩内核验证 -t/-d/-f、并发临时文件、拒绝时保持旧配置、提交只写最终配置，并验证拒绝提示带出生效的覆写文件与作用域（无覆写生效时不出现该段） |
| 设置 | settings.spec 用真实子进程验证每次读盘、mutator 失败不写入，以及 4 进程并发更新设置和订阅缓存不丢条目；端口校验在合并默认值之后执行，单侧配置撞另一侧默认报错 |
| reset | commands/reset.spec 用临时数据目录和独立服务 label 跑真实 CLI，检查全量/部分/不同目标顺序、不重建设置、默认覆写开关与下载残留清理 |
| 命令与选项 | 注册表/补全与参数测试；带值选项 exact / attached / 等号三种形式由 `matchValueFlagToken` 统一判定（白名单、`parseIntArg`、重启透传三处共用），不变量测试遍历 `FLAGS` 锁死「白名单接受 ⟹ 下游可消费」（反向验证：临时让透传丢掉 attached 即转红）；布尔开关拒绝附加值，未知输入统一报错；sub 白名单按子命令校验（13 条用例，反向验证：换回全组放行恰好 5 条转红）；多余位置参数在全部消费点报错（positional-args.spec 25 拒 + 19 放行） |
| 服务并发 | service-concurrency.spec 用 PATH 前置桩 launchctl + 桩 controller 驱动真实模块（launchd 零接触）：热重载成功后计数已变则报「启动已取消」（反向验证：撤掉复读恰好转红）；stop 锁内慢 launchctl 的持锁时长断言低于 `LOCK_STALE_MS` 真实常量（反向验证：还原 5s 超时实测持锁约 12s 超阈值，原缺陷复现） |
| 文件锁 | paths.spec：deadline 到点不抢新鲜锁（等待者各自过线也只等对方释放，双等待者临界区不重叠）；反向验证：还原无条件 rmSync 后以正确原因转红 |
| 归档轮转 | log-files.spec：原子占名（openSync 'wx'）后双进程同时分配拿不同路径、同时轮转同一日志恰一份归档；反向验证：换回 existsSync-then-rename 后 4 条转红且两次运行稳定复现覆盖 |
| 网络路径 | kernel/http.spec：代理路径 curl 加 `--fail-with-body` + 状态码复核（3xx 不跟随时退出码也是 0，故双保险）；真实 CONNECT 隧道代理对 api.github.com 端到端取到版本，连接拒绝口径不变；API 查询异步化（130s 不再阻塞事件循环）；https 判定经 `new URL` 规范化，大写 scheme 不再绕过降级守卫 |
| TUN 模式判据 | runtime.spec：`restartModeFor` 纯函数锁「TUN 在跑即 tun（含服务已装组合）」，真实桩内核 + pid 文件端到端验证 `getRuntimeMode` 答错时决策仍答 tun |

原生 -t 只验证配置解析，不能证明节点可达、端口可绑定或真实 TUN 路由正常；服务健康与代理连通性检查仍有独立价值

## 已有验证仍支持的结论

以下结论来自已有测试或前次真机实测，本轮未全部重新搭建现场

- 原子写临时名带 pid 与进程内序号；锁释放校验所有权，陈旧锁可恢复，根目录锁不会被 runtime/subscriptions 重置带走（paths.spec）
- YAML 解析保留共享引用与锚点，JSON 无需第二套解析；match 为空或键名错误时拒绝加载（config/overwrite 测试）
- process-probe.spec 调真实 pgrep 验证 POSIX ERE；process-stop.spec 用路径隔离的桩进程跑真实 pkill，覆盖批量清理与 PID 复用
- service-exitcode.spec 只读调用真实 launchctl，确认 113 未装载、112/125 查询失败；service.spec 验证顶层字段、信号死亡与停止计数判据
- root-guard.spec 验证入口在创建数据目录前拒绝 root；用户态 LaunchAgent 无权创建 TUN
- launchd 的 terminating signal 与 last exit code 两字段互斥；需要 describeExitCause 同时覆盖
- disabled label 的 bootstrap 硬失败，enable 必须在前；bootstrap 返回 0 不表示内核已健康，TUN 的 kill -0 也不能排除僵尸进程
- 内核四种下载通道曾各自下载真实产物；kernel.spec 覆盖通道选择、标准资产选择、curl/gh 参数纯函数、tar 列表大小解析（`parseTarEntrySize`）。tar 的路径穿越（-tzf）与类型（-tvzf）两道守卫逻辑内联在 downloadKernel，无直接用例，改动时需补
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- 覆写「未命中即追加」是 ssh 出口与 provider 场景依赖的承诺，故不改 `~key`；「只改已有、不新增」由 `~?key` 显式表达，跳过时告警。不在 CLI 复制一份分组必填字段校验（字段集随内核漂移），残缺元素仍由 `-t` 拒绝

## 未覆盖与待复核

- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。已修；热重载成功分支（PATH 前置桩 launchctl + 桩 controller）与查询失败回退分支（计数桩 launchctl）均已自动化（service-concurrency.spec，不碰真实 launchd），install 恢复分支仍只能手工复现
- 控制器/入站家族锁定（external-controller-tls/-unix/-cors/-doh、tuic-server、ss-config/vmess-config、tls 段）只回上游源码核对了键名与启动前提、用 buildConfig 实测了剥除，没用真内核验证过额外监听真的开不出来；unix socket 文件创建、TUIC/SS/Vmess server bind 等内核侧行为同理
- **锁定清单的完整性靠人肉对表，没有机制保证**：`LOCKED_CONFIG_KEYS` 与上游 `config.Inbound` 字段集之间没有自动比对（要做得解析 Go 源码或钉住上游版本），漏键只能靠复核发现——redir/tproxy（4.9.0）、-tls/-unix/-doh 与 tuic-server（4.9.1）、ss-config/vmess-config（4.9.2）三轮各漏一批，每轮都以为「这次逐个核对过了」。下次核对别按键名眼熟程度挑，照 `Inbound` 结构体字段 + `updateListeners()` 的 ReCreate* 入参逐个对；上游新增入站类型时本清单必然滞后
- `listeners` 与 `tunnels` 都是通用入站声明、订阅可指定监听地址，当前原样进运行配置（与 4.9.0 对 listeners 的决定一致，两个键须一起评估）；`iptables` 是 Linux 专用、darwin 内核无该路径，同样保留。若产品上决定锁定，三者的测试在 config.spec「待定入站面」用例会立即失败提示
- 锁定告警只对覆写文件：覆写经操作符设置锁定键（如 `+secret`）已覆盖，但覆写文件内 `match:` 块之后、且文件解析失败被 warn 跳过时不会有告警（文件整体没生效，合理）
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- 锁内 launchctl 调用有持锁预算（最坏总时长 < `LOCK_STALE_MS`）：start 侧 enable+bootstrap 两次默认 5s、恰好等于阈值，是既有基线（startService/installService 本就如此），不因本轮变化；stop 侧 bootout+disable+复核共三次，单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s），别再往任何锁内加东西。锁内三环节（复核先于递增、递增在锁内、bootout 与 disable 同锁）谁也挪不出锁，缩减调用次数的路走不通，理由见 service.ts 该常量注释
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- fish 补全脚本未做语法校验：本机未装 fish。zsh/bash 经 `zsh -n`/`bash -n` 校验过，改动补全生成逻辑时注意 fish 那份只有生成、没有验证（gating 与词表派生已由 completion.spec 字符串级断言锁住，语法仍无验证）
- `config` 命令不做内核校验，故它能输出「形态合法但内核会拒绝」的配置（例如引用了不存在的节点）。这是刻意的分工——校验归 `doctor` 与 `start`，只读展示不该要求装了内核
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路只能真机 sudo 验证：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受之；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- TUN 运行中 `sub use`/`ow` 的按原模式重启与更新提示（`start tun`）已修，但真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未复测，仅经 runtime.spec 的桩内核路径验证决策
- 本轮深审其余未修的低危项：`unhandledRejection`/`uncaughtException` 已统一口径但渲染函数本身不可注入测试；补全 install 的「已含标记块幂等跳过」无用例；`NO_COLOR`/stderr 设色经 pty 手工验证、无自动化；clearProxyEnv 对企业 env 代理网络的影响已文档化（CLAUDE）但无提示机制。`npm_config_proxy` 等 npm 专属代理变量未清——npm 读 npmrc 不依赖该 env、gh/curl 不识别，不构成下载死锁，保持现状
- 4.9.0 复审记录但未修（判定接受或不可自动化）：`FORCE_COLOR` 不支持、`TERM=dumb` 仍出色；无 `--` 结束选项约定（当前无需要它的入口，订阅名已禁止 `-` 开头）；tar 穿越/类型两道守卫仍内联无直接测试；gh 资产名未拦前导 `-`（仅 GitHub API 被篡改时可达）；代理探测 curl 未加 `--proto =https`（只看 204 无机密）；findBinaryInDir 同目录多匹配时不保证精确名优先（有 -v + 版本对账两道门）

## 已评估未采纳

- **全局 `--verbose`**：输出散在 24 个模块的 265 处直接 `console.*`，无中心化日志层；且选项按命令白名单校验（`assertKnownFlags`，14 处），全局开关要么加满 14 个白名单、要么在 index 集中剥离——横切改动大而收益不明。排查已有三条路径：`doctor`（体检加修复指引）、`logs`、`status --json`。真要做，先建日志层再谈开关

## 自动化测试边界

真实 sudo/TUN 会修改路由、需要密码并可能留下 root 属主文件，开发机和 CI 不自动执行

完整服务启停测试也不默认运行：enable/disable 会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 给每个临时 label 留永久记录，launchctl 无清除动词；只用 bootstrap/bootout 的一次性 label 可以临时验证有限的 launchd 行为，但不能覆盖 stop 的全部语义。要驱动服务层的 launchctl 路径时用 PATH 前置的桩 launchctl（service-concurrency.spec 的做法）：代码走真实路径、真实 launchd 一点不被碰，配 HOME/MIHOMO_CLI_DIR/一次性 label 三层隔离

进程与 reset 测试必须验证隔离前提：临时 MIHOMO_CLI_DIR 限定进程路径，独立 MIHOMO_CLI_DAEMON_LABEL 限定 plist/服务查询；仅隔离数据目录不足以保护用户服务

## 平台实测备忘

- kickstart -k 可能阻塞超过 5s，当前使用独立的 60s 超时；bootout 未装载目标返回 3
- KeepAlive.PathState 只决定退出后是否重启，删除标志文件不会主动停止进程，不能用来替代 stop
- disabled 位独立于 plist 持久化，enable 也留记录；手工移除需 sudo plutil，keypath 的点须转义，磁盘修改要重启后才与 launchd 内存一致，不能做进 CLI 自动清理
- BSD ps command 列需 -ww，stat 用 -f%z；open 是异步桌面操作，返回后才可能失败，调用方保留手动路径
- 未装内核的开发机是正常环境，不能为了检查自动安装用户服务或提权；真机结论可能来自其他测试机器

## 文档与流程复盘

稳定约束集中在 CLAUDE，历史保留在 CHANGELOG/git

v4.9.2 的教训是关于本文自身：**「已核对」的记述会被后人当成已核对，从而关掉这条线索**。v4.9.1 写下「键名逐个回上游 General 段核对」时并未真正遍历 `Inbound` 字段集，而这句话此后成了不必重查的理由。此类声明要落到可复现的对表方法（照哪个结构体、哪个函数的入参），不写「逐个核对过」这种无法复核的完成态；写完再回头验一遍声明本身是否属实

发布后也要回头改状态：v4.9.1 发布后本文仍留着「待发布」和旧的测试数（596，`d4eb38b` 补 3 条后没同步），两处都在 v4.9.2 修正。release 流程第 14 项要求同步本文档，实际漏的是**发布动作完成之后**那次状态更新

类型检查曾漏掉测试字符串内对已删除导出的引用，已修正并把全仓搜索要求写入 CLAUDE；发布流程的注册表示例也同步去掉了失效字段
