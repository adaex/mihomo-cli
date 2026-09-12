# 代码审查：验证结论与边界

当前审查：2026-09-12，待发布（基于 v4.8.1 之上的 16 项修复）

本轮对全仓做了一次分模块深审（launchd 与进程、数据锁与下载、配置构建与覆写、命令层与横切），产出 28 条发现并修掉 16 条：三条实测复现的并发缺陷（锁 deadline 删新鲜锁、TUN 运行中配置变更被切回 Mixed、热重载成功不复读停止计数）、覆写嵌套键语义统一为字面（用户拍板）、以及一批「承诺写在注释、机制没盖到」的一致性缺陷（紧贴值选项三套解析器、sub 白名单全组放行、补全四份词表、豁免命令副作用、warnings 出口）。剩余 12 条多为待真机验证或低危，见「未覆盖与待复核」。launchd 的真实启停与 TUN 提权流程未做端到端复测

规则见 CLAUDE，修复历史见 CHANGELOG；本文保留验证方法、仍有效的实测事实与未覆盖风险，改相关代码时同步更新

## 本轮验证

类型检查、550 项测试（+210）、Biome（实际检查 79 个文件）与构建通过；registry 产物拉回实跑（version、紧贴值报错）确认 tarball 完整。**时序用例在并行负载下可能偶发抖动**：发布验证期间一次与 build 并行的 `npm test` 挂过 1 条（未留日志，推断为三进程编排/持锁时长断言之一），随后 6 次串行运行全过；跑并发场景测试时避免与其他重负载任务并行，抖动重跑即过——若要根治需放宽时序余量，代价是缺陷检出灵敏度

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
- 内核四种下载通道曾各自下载真实产物；kernel.spec 覆盖通道选择、标准资产选择、HTTPS 与归档路径/类型检查
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- 覆写「未命中即追加」是 ssh 出口与 provider 场景依赖的承诺，故不改 `~key`；「只改已有、不新增」由 `~?key` 显式表达，跳过时告警。不在 CLI 复制一份分组必填字段校验（字段集随内核漂移），残缺元素仍由 `-t` 拒绝

## 未覆盖与待复核

- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支与 restart 回退的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。已修；热重载成功分支已用「PATH 前置桩 launchctl + 桩 controller」自动化（service-concurrency.spec，不碰真实 launchd），回退与 install 恢复分支仍只能手工复现
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- 锁内 launchctl 调用有持锁预算（最坏总时长 < `LOCK_STALE_MS`）：start 侧 enable+bootstrap 两次默认 5s、恰好等于阈值，是既有基线（startService/installService 本就如此），不因本轮变化；stop 侧 bootout+disable+复核共三次，单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s），别再往任何锁内加东西。锁内三环节（复核先于递增、递增在锁内、bootout 与 disable 同锁）谁也挪不出锁，缩减调用次数的路走不通，理由见 service.ts 该常量注释
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- fish 补全脚本未做语法校验：本机未装 fish。zsh/bash 经 `zsh -n`/`bash -n` 校验过，改动补全生成逻辑时注意 fish 那份只有生成、没有验证（gating 与词表派生已由 completion.spec 字符串级断言锁住，语法仍无验证）
- `config` 命令不做内核校验，故它能输出「形态合法但内核会拒绝」的配置（例如引用了不存在的节点）。这是刻意的分工——校验归 `doctor` 与 `start`，只读展示不该要求装了内核
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路只能真机 sudo 验证：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受之；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- `listeners` 是否进删除清单属未定产品决策（订阅以 listeners 投递入站是否合法）：本批未动，订阅自带 listeners 仍原样进运行配置
- TUN 运行中 `sub use`/`ow` 的按原模式重启与更新提示（`start tun`）已修，但真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未复测，仅经 runtime.spec 的桩内核路径验证决策
- 本轮深审其余未修的低危项：`unhandledRejection`/`uncaughtException` 已统一口径但渲染函数本身不可注入测试；补全 install 的「已含标记块幂等跳过」无用例；`NO_COLOR`/stderr 设色经 pty 手工验证、无自动化；clearProxyEnv 对企业 env 代理网络的影响已文档化（CLAUDE）但无提示机制

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

本轮删除了过期实现说明与重复事故清单；稳定约束集中在 CLAUDE，历史保留在 CHANGELOG/git

类型检查曾漏掉测试字符串内对已删除导出的引用，已修正并把全仓搜索要求写入 CLAUDE；发布流程的注册表示例也同步去掉了失效字段
