# 代码审查：验证结论与边界

当前审查：2026-09-08，基于 v4.7.7 的未发布改动

本轮覆盖配置构建、设置读写、reset、命令注册与参数处理，并清理过期文档；launchd 的真实启停与 TUN 提权流程未做端到端复测

规则见 CLAUDE，修复历史见 CHANGELOG；本文保留验证方法、仍有效的实测事实与未覆盖风险，改相关代码时同步更新

## 本轮验证

类型检查、301 项测试、Biome（实际检查 67 个文件）与构建通过；构建产物在隔离目录通过 31 项命令检查，覆盖旧输入拒绝、help/version、三种 shell 补全、JSON 状态与完整 reset

| 范围 | 验证方式与结论 |
| --- | --- |
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
- 停止计数的纯函数与文件测试不能代替所有命令交错验证；静态检查发现 install 恢复分支取快照偏晚、已停止时 cmdStop 提前返回不更新计数、restartService 回退启动缺少同样的计数保护，这三条需在服务并发专题中复现并处理
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换

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
