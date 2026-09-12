# 代码审查：验证结论与边界

当前审查：2026-09-12，已随 v4.8.0 发布

本轮清掉「未覆盖与待复核」里挂着的三条服务并发缺陷，顺着同一族形态又找出三处；另补三处用户侧缺口（Node 版本守卫、补全卸载、`config` 查看生效配置）。launchd 的真实启停与 TUN 提权流程未做端到端复测

规则见 CLAUDE，修复历史见 CHANGELOG；本文保留验证方法、仍有效的实测事实与未覆盖风险，改相关代码时同步更新

## 本轮验证

类型检查、325 项测试（+24）、Biome（实际检查 68 个文件）与构建通过；构建产物在隔离目录（含隔离服务 label）复核 stop 两次递增、无 plist 残留、无进程残留

| 范围 | 验证方式与结论 |
| --- | --- |
| stop 的提前返回 | commands/stop.spec 用真实 CLI 打隔离目录 + 不存在的 label：该组合天然走「不在运行」分支，一次 launchctl 写操作都不做。断言消费者可见的后果（`shouldAbortStartOnDisable` 判为变了）而非文件内容，并含负向对照（`status` 不得改变计数） |
| 游离内核清理 | 同上文件：真实桩内核（命令行绑定隔离目录）被杀后同样记录；判活以 `ps` 状态列为准，不用 `kill -0`（僵尸进程会骗过它） |
| reset 的边界 | commands/reset.spec 补一条：`needsStop` 为真的 `reset logs` 记录停止，纯配置的 `reset ow` 不记录 |
| 测试有效性 | 临时注掉两处 `recordServiceStopped` 复核，两条用例即转红，确认不是恒真断言 |
| Node 版本守卫 | commands/node-guard.spec 伪造 `process.versions.node` 跑真实入口（真装旧 Node 连 tsx 都未必起得来，反而测不到守卫）：四个命令被拒且退出非 0、help/version 豁免、被拒时不留数据目录、满足下限时放行 |
| 补全装卸 | commands/completion-install.spec 把 HOME 指向临时目录跑真实装卸，断言文件最终内容：bash 卸载后用户自有内容完好且标记块消失、反复装卸不留空文件、非本工具产物拒绝删除且文件仍在 |
| config 命令 | commands/config.spec 全部在没有 runtime/config.yaml 的目录里跑（锁住「重新推导」这一性质）；输出经 js-yaml 实际解析确认是合法 YAML，secret 已脱敏，`--json` 同样脱敏 |
| 补全脚本语法 | 生成的 zsh/bash 脚本经 `zsh -n`/`bash -n` 校验；fish 未装，未校验 |
| 配置构建 | config/config-dns/overwrite 测试验证 JSON/YAML、形态错误、覆写 DSL、作用域与 TUN DNS；节点、分组和规则不再被隐式修复 |
| 原生配置校验 | mihomo v1.19.30 在临时目录执行 -t：Mixed/TUN 合法配置通过；缺失节点、规则目标、重复节点名和缺失 provider 被拒绝；拒绝后旧 config.yaml 保留、候选文件清理 |
| 配置提交协议 | subscription-prepare.spec 用隔离桩内核验证 -t/-d/-f、并发临时文件、拒绝时保持旧配置、提交只写最终配置 |
| 设置 | settings.spec 用真实子进程验证每次读盘、mutator 失败不写入，以及 4 进程并发更新设置和订阅缓存不丢条目 |
| reset | commands/reset.spec 用临时数据目录和独立服务 label 跑真实 CLI，检查全量/部分/不同目标顺序、不重建设置、默认覆写开关与下载残留清理 |
| 命令与选项 | 注册表/补全与参数测试；当前布尔开关拒绝附加值，未知输入统一报错 |

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

## 未覆盖与待复核

- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支与 restart 回退的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。已修，未自动化
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- 锁内 enable+bootstrap 最坏两次 5s 超时，恰好等于 `LOCK_STALE_MS`；这是既有基线（startService/installService 本就如此），不因本轮变化，但别再往锁内加东西
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- fish 补全脚本未做语法校验：本机未装 fish。zsh/bash 经 `zsh -n`/`bash -n` 校验过，改动补全生成逻辑时注意 fish 那份只有生成、没有验证
- `config` 命令不做内核校验，故它能输出「形态合法但内核会拒绝」的配置（例如引用了不存在的节点）。这是刻意的分工——校验归 `doctor` 与 `start`，只读展示不该要求装了内核

## 已评估未采纳

- **全局 `--verbose`**：输出散在 24 个模块的 265 处直接 `console.*`，无中心化日志层；且选项按命令白名单校验（`assertKnownFlags`，14 处），全局开关要么加满 14 个白名单、要么在 index 集中剥离——横切改动大而收益不明。排查已有三条路径：`doctor`（体检加修复指引）、`logs`、`status --json`。真要做，先建日志层再谈开关

## 自动化测试边界

真实 sudo/TUN 会修改路由、需要密码并可能留下 root 属主文件，开发机和 CI 不自动执行

完整服务启停测试也不默认运行：enable/disable 会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 给每个临时 label 留永久记录，launchctl 无清除动词；只用 bootstrap/bootout 的一次性 label 可以临时验证有限的 launchd 行为，但不能覆盖 stop 的全部语义

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
