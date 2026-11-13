# 现行结论与边界

只收**现行有效**、且不属于别处的四类内容：

1. 平台与上游的**实测结论**：外部系统的行为事实，每条自带证据
2. 有意接受的**残余风险与已知缺口**：写清触发条件、不修的理由，改相关代码时先确认窗口没有变宽
3. **只能手工验证的范围**：不进自动化的路径与原因；测试方法纪律在 [development.md](docs/development.md)
4. **已评估未采纳的方案**：只限单模块、呈现层或工具链层面的取舍；跨模块架构决策与其拒绝的替代方案归 [decisions.md](docs/decisions.md)，不在此重复

跨模块契约见 [architecture.md](docs/architecture.md)，版本历史见 CHANGELOG 与 git tag

正文按主题分节，条目的内容类型按上面四类判据归属；每条自带证据与取舍，过时即删，当轮验证过程留在提交信息。改到相关代码时同步更新对应节

## 平台与 launchd（实测）

- `launchctl print` 退出码：113 = 未装载，112/125 = 查询失败；`bootout` 对未装载目标返回 3（service-exitcode.spec 只读调用真实 launchctl 复验）
- `pgrep`/`pkill` 退出码：0 命中、1 无匹配；2 正则编译失败、3 fatal error 属探测自身失败，不是「没有进程」——pgrep 只收 0/1、其余抛错（process-probe.ts），pkill 的 2/3 同样不当无进程吞掉（process-stop.ts）
- launchd 任务的 terminating signal 与 last exit code 两字段互斥，`describeExitCause` 需同时覆盖
- disabled label 的 `bootstrap` 硬失败，`enable` 必须在前；`bootstrap` 返回 0 不表示内核已健康，TUN 的 `kill -0` 也排除不了僵尸进程
- `kickstart -k` 可能阻塞超过 5s，使用独立的 60s 超时，远超锁的 10s 强夺阈值，因此必须留在锁外（交错残余见「服务、锁与并发」）
- `KeepAlive.PathState` 只决定退出后是否重启，删标志文件不会停进程，不能替代 stop
- disabled 位独立于 plist 持久化（磁盘表 `/var/db/com.apple.xpc.launchd/disabled.<uid>.plist`），`enable` 也留记录；手工移除需 sudo plutil（keypath 的点须转义），磁盘修改要重启后才与 launchd 内存一致，不能做进 CLI 自动清理
- BSD `ps` 的 command 列需 `-ww`，stat 用 `-f%z`；`open` 是异步桌面操作，返回后才可能失败，调用方保留手动路径
- `sudo pkill -f <PATTERN>` 不会匹配 sudo 脚本自身的命令行：`escapeRegExp` 把点转义后，进程命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点，恰好坏掉自匹配（对照实验：把 `\.` 换回 `.` 立即自匹配）。三个 root 脚本同此结论，不加行首锚；未来若改用未转义拼接必须重验
- 未装内核的开发机是正常环境，不为检查自动安装用户服务或提权；真机结论可能来自其他测试机器

## 内核下载与上游

- 上游 mihomo 已查资产（v1.19.30 实测）只有单文件 `.gz`（gzip 解压，`maxBuffer` 256MB 即体积上限），非 `.gz` 资产显式报错；**不提供 checksums**，来源钉死（`assertTrustedAssetUrl`）、大小比对与执行自检保留，不能写成已验证哈希
- gh（Go）只认 `HTTPS_PROXY` / `https_proxy`，无命令行代理选项；入口清除自指代理后若不注入，gh 会直连。故下载候选带本机代理、`buildGhDownloadEnv` per-spawn 注入；显式注入时同时清 no_proxy/NO_PROXY，避免例外表把回退改回直连（D9，kernel.spec 锁定）
- 上游面板自升级（update_core.go）的 `meta-backup` 是有意永久保留的旧内核副本：成功路径只 defer 清理 `meta-update`、从不清 `meta-backup`（每次升级覆盖写，已核对上游源码）。doctor 只把 `meta-update` 当真残留告警，`meta-backup` 按信息项给独立删除口径，绝不与暂存共用一条 `rm -rf`——合并告警会让面板成功升级一次后 doctor 永久误报，修复命令还会连回滚备份一起删
- 上游 MetaCubeX/mihomo 的默认分支 `main` 自 2026-09 起是同名 Python 项目，内核源码与发布仍在 `Meta` 分支。版本查询与下载走 releases API（tag 固定、资产 URL 不变），不受影响；**上游源码核对（锁定清单对表）必须带 `?ref=Meta`**，config-inbound-snapshot.spec 的引用已带

## 配置、订阅与覆写

- 原生 `-t` 只验证配置解析，不能证明节点可达、端口可绑定或真实 TUN 路由正常；服务健康与代理连通性检查仍有独立价值
- 顶层未知键内核**不拒**（真内核 `-t` 实测 `enabled: false` 照常通过）——元数据剥离与近失校验完全是 CLI 的责任。`Enabled`、`enabled!`、`Match`、`+match` 若按普通键放行，文件内其他配置仍会按启用、无 match 的全局范围生效，因此加载时必须显式报错；`~` / `~?` / `<x>` 旧语法同样给迁移指引，不能静默失效
- **config-graph 不能用 js-yaml 的 `maxAliases` 替代**：该上限只数别名节点个数、不限展开体量——40 层倍增链（每层引用上一层两次）只用约 80 个别名即可加载并展开成 2^40 个节点。故保留带完成缓存的 DFS：active/completed 分离检查循环与 200 层深度，完成节点缓存展开成本与子树高度，共享 DAG 不按展开体量遍历。100000 展开节点预算只服务 config 脱敏与 JSON（含 `--reveal` 的单独预检）；下载、start、内核校验只查循环与深度，不套展示预算
- **订阅下载不自动选择运行中的 Mixed 或系统代理**：HTTP 客户端是 Node 原生 fetch，undici 默认不读 env 代理（Node 24 需显式 `NODE_USE_ENV_PROXY=1`），也不读 macOS 系统代理。入口只清指向本机 Mixed 的自指 env，其他代理保留；显式启用 NODE_USE_ENV_PROXY 时，非自指代理可被 fetch 使用，自指代理仍被防护。要按运行态自动经 Mixed 下载是独立特性，需另评 undici dispatcher，不能在服务未运行时无条件指向自己的端口
- `downloadSubscription` 的缓存写失败回滚以写前内容为准：原有 YAML 逐字恢复，仅原本不存在文件时删除本次产物；回滚异常进入提示，不得假报已恢复或已删除。YAML 写入、缓存提交与失败回滚同在 `subscriptionCommitLock` 内串行，较慢下载的回滚不能覆盖另一进程已提交的新配置
- 覆写文件级校验（已移除操作符、空键、互斥修饰、残留 `!` `+`、数组操作符命中 BASE_CONFIG 非数组键）在 `readOverwriteFiles` 加载阶段执行：诊断旁路（ow/status）与合并闸门（start/config/doctor）看到同一份 broken 列表（D7）；依赖订阅当前值的冲突仍只在合并期报错，因为 ow 不绑定订阅
- 订阅侧 own `__proto__` 刻意不拦（探针实测）：js-yaml 解析订阅顶层 `__proto__:` 得 own 键，经展示 walk（`defineProperty` 绕原型 setter）与 dump 均不炸，内核按未知键忽略；只有覆写**合并层**在操作符解析后拦截，订阅侧透传是承诺行为
- `config` 是按当前缓存与设置重新推导的**配置预览**，不写盘、不重启、不做内核校验，因此可能展示内核会拒绝的配置；校验归 `doctor` 与 `start`，预览也不保证与会先自动更新订阅的下一次 `start` 完全相同
- `status --json` / `config --json` 的 stdout 在空环境、设置损坏告警期、有 warnings 三种场景下始终可整体解析，告警一律走 stderr
- `matchesScope` 有两个 fail-open 边界（fuzz 差分定性，不加防御）：`match.name: ''`（空串 falsy 被跳过 → 无条件应用）与单独 `'*'`（头部 `*` 分支 slice 出空串 → `endsWith` 恒真）。README 承诺的「空值报错、单独 `*` 报错」在文件加载期（`normalizeMatch`）拦截，真实文件路径到不了 `matchesScope`，仅手工构造 Entry 才可达
- 入站/控制面锁定清单（D5）只有半自动兜底：config-inbound-snapshot.spec 冻结带上游版本号的 `config.Inbound` 字段集，差集必须逐项写明放行理由。**快照发现不了上游新增字段**，内核大版本升级时仍须人工刷新并对照上游源码——核对证据是实际执行集与上游消费点，不是注释或测试名里曾出现过某个键
- 锁定 `authentication` 的代价：剥除来源盲，用户也不能再用覆写给 Mixed 端口设代理鉴权。缓解是 `allow-lan` 已强制 false、Mixed 只监听回环，主要威胁面（局域网）已消失；残余是同机其他进程（含浏览器网页），与控制器默认无鉴权同一量级。控制器侧有 `controller_secret` 逃生口，Mixed 侧暂无——真有人需要再加 settings 键，不提前造开口

## 服务、锁与并发

下列残余窗口均已评估，判定为触发条件苛刻、修复收益不抵复杂度；改相关代码时先确认没有让窗口变宽

- 残留内核清理唯一入口是 `cleanupAll`（process-stop.ts）：stop/start/uninstall/reset 共用，root 残留走一次 sudo 脚本，发信号后统一 5s 死亡等待再复核 pgrep。清理没走完经 `CleanupResult.incomplete` 带出：进程仍在则服务层抛错，已清空只警告。**pid 文件清理免提权**（runtime/ 归用户所有，root 属主的 TUN 残留也直接删），但**仅在复核 remaining 为空时才删**——pid 文件是 status 的真相源，活进程在时删会让 status 报「未运行」
- `kickstart` 失败后的回退只在本次 `bootstrap` 确实成功时进入健康确认；`bootstrap` 的「已装载」幂等吸收只属于启动与安装恢复路径，不能充当本次重启证据（service-restart-fallback.spec 桩 launchctl 正反两路）
- `kickstart -k` 留锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable / re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- `uninstallService` 只在锁内 disable 一次，不做锁外重复 disable（冗余且会多 bump epoch）
- **start‖start 互替的观察窗误报**：A 已通过锁内 bootstrap、处于健康观察窗（1.2–3s、锁外）时，B（连敲的第二次 start / sub use / ow 重启）完成 bootout + bootstrap 把 A 的任务换成自己的——A 的轮询读到 unloaded，报「内核未能进入运行状态」附日志尾部，而终态正确。触发要求 B 的全程落进 A 的观察窗；B 是 start 不 bump epoch，失败复读判据抓不到它。修复方向（备查）：健康轮询最终 `healthy:false` 分支复用 `healthViaProcessProbe` 兜底；代价是健康判据再增一个消费语义，损害仅错误文案的排查方向
- **stop 游离路径批量 pkill 与并发 start 的交错**：B 读 status（未装载）→ 并发 A bootstrap 并拉起服务内核 → B 读 pids 命中 A 的内核 → `stop()` 的 `cleanupAll` pkill 杀掉它，KeepAlive 约 10s 拉回（游离路径不 bootout）。B 报「已停止」与终态相反。与已接受的「探测与动作之间隔一次查询」同族，方向相反（stop 伤 start）
- **reset 确认后重读仍有残余窗口**：危险分支（重读时 serviceActive=false）里，重读之后到删除 kernel/config 之间还隔着 `cleanupAll` 的 root 残留提权（sudo 密码窗最长 60s）；serviceActive=true 分支还隔 stop/uninstall 自身的锁等待（≤10s）与 bootout + waitUntilUnloaded（≤5s）。并发 install+start 整体落进这些窗口时其锁内判定放行（epoch 基线取自最近 bump 之后），删除后 KeepAlive 崩溃循环。不修：删除前再读再 stop 会引入第二层窗口（无穷回归），且触发需「root 残留内核存在 + 并发 install+start 恰在窗口完成 bootstrap」双重前置；若将来 reset 支持并发场景，优先把删除段并入 serviceLock 临界区
- **文件锁 stat→unlink 两步、不复核 inode**：①等待者被冻结（合盖/换出）且系统时钟前跳，新鲜锁被当陈旧锁删；②持锁者已崩溃、锁确已陈旧时有两个等待者同走强夺，C 在自己的 stat 与 rm 之间被挂起，恢复后 `rmSync` 删掉 B 刚夺到的新鲜锁并自己 wx 成功，B/C 同时进临界区。token 所有权校验只防 finally 误删，防不住这个。两者都要求相邻两个同步 syscall 之间被调度挂起，属微秒级窗口；macOS 无用户态原子比较-删除原语，读后复核只能缩小窗口并制造虚假安全感，彻底关闭需更换锁原语（架构级），与「陈旧锁退回无锁竞态」同级接受
- **remove 并发在途 sub update/add 的孤儿 yaml 与 cache 条目**：下载刻意不持 settings 锁（60s 下载不能压进临界区），写盘只认命令开头快照的订阅名、不复核 settings。remove 走完全程后在途下载照写：add 路径 B 的 yaml 在 postCommit rm 之后才写出；update 路径把刚删的旧 yaml 原地复活，cache 条目同样被写回。add 路径另有文案失真：`setDefaultSubscription` 返回 false 被忽略，照打「已添加并切换」。无行为消费方——yaml 与 cache 都只按 settings 里的名字读，仅 `dir open subs` 与手翻 cache.json 可见；同名 `sub add` 覆盖自愈或 reset 清理。封死需下载完成后二次确认归属（写盘段进 settings 锁、锁内复核条目仍在），但会打破 `downloadSubscription`「与 settings 解耦的下载原语」契约（缓存写失败回滚与写盘闸门两套 spec 都拿未入库的 probe 名直接调它）
- `ui` 的 `getRunningState` 查询无容错：launchctl 瞬时失败会把 `ui` 挡死报「无法查询服务状态」。ui 是纯打开操作，失败重跑成本低且打开后不再依赖该查询；若将来 ui 增加依赖运行态的分支，先补容错
- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换

## TUN 与 sudo

- TUN 在 sudo 返回与启动失败后都复读停止计数；发现并发 stop 时先清理已启动内核，remaining 非空则报停止失败，清理完成后才报启动取消（runtime-tun-concurrency.spec 用假 sudo 在窗口内递增计数并复核进程终态）
- **sudo 密码窗口内 Ctrl+C 最长 60 秒无响应**（已知权衡）：两处提权（TUN 启动 / 残留清理）的 `spawnSync('sudo', …, {stdio:'inherit', timeout:60s})` 阻塞主线程，期间信号处理器无法执行，与 process-stop.ts 头注释「轮询必须 async 保障 SIGINT 可达」的预期在此窗口相悖。改异步 spawn 需自行处理 sudo 子进程回收与 TTY 归属，复杂度远超收益；超时上限 60s 有界，非死锁
- **TUN 启动的亚秒窗口内并发 stop 删 pid 文件**：脚本写完 pid 文件、内核尚未出现在 pgrep 的窗口内，并发 stop/reset 的零进程分支会删掉刚写的 pid 文件 → `startTun` 末尾 `getPid()` 为 null，把成功启动误报成「TUN 启动失败」。与上一节「stop 游离路径」同族，窗口亚秒级且旧 sudo 版同样存在，封死需 start/stop 共享锁（跨进程锁在数据根目录、进程启动不在锁内）
- **sudo 取消路径的日志窗口**：`startTun` 的日志轮转在存在性校验之后，但轮转（rename 归档）到 pkill 实际执行之间用户取消的话，仍在运行的旧 TUN 内核会继续往归档文件写。rename 进不了 root 脚本（归档命名/清理在 TS 层），接受——下次成功启动自愈，logs 列表短暂缺当前日志
- TUN 方向的并发防线同族残余：`startTun` 复核点到 sudo 脚本内 pkill 实际执行之间隔着密码窗口，pkill 在 root 脚本内进不了锁。两道防线合起来覆盖「B 在 A bump 之前/之后进锁」两种交错，但「B 恰在 A 复核后、pkill 前完成 bootstrap」的毫秒级窗口仍在——B 出锁前锁内 epoch 检查读的是 bump 后的值会放弃，故该窗口要求 B 的整个 enable + bootstrap 压进 A 复核到 pkill 之间，实际可达性极低，与 `kickstart` 锁外交错同级接受
- TUN 运行中 `sub use` / `ow` 按原模式重启、更新提示使用 `start tun`；真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未自动复测，仅经 runtime.spec 的桩内核路径验证决策

## 文件、日志与 CLI 约定

- **原子写 fsync/fchmod 的文件系统边界**：非常规文件系统（如 NFS home）上 fsync 可返回 EINVAL，fchmod 是第二个硬失败 syscall（FAT/exFAT 类权限位无意义）；两者都使原本 rename-only 能成功的写入整体失败——与 fsync 同一姿态接受，服务层不用感知。macOS APFS 实测无问题，未在其他文件系统实测。保证范围分层写在 `atomicWriteFileSync` docstring；崩溃遗留 `*.tmp` 的清扫在三道守卫与豁免判定**之后**执行（清扫是删除动作，不在被拒绝/豁免的命令上跑）
- `cleanupStaleTmpFiles` 按 1h 龄清扫原子写 `<目标>.<pid>.<序号>.tmp`、`kernel/.tmp-XXXXXX`、根目录 `check-XXXXXX` 与 `service.plist.stage`；`lstat` 核对文件/目录类型，名称或类型不符一律保留。全小写六位后缀与 `check-backup` 等手工目录无法区分，宁可漏扫也不误删（下载硬超时 180s，清扫 1h 有 20 倍余量；paths.spec）
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- 裸 `-` 在 argv 层按未知选项拦截、不豁免：本 CLI 没有「`-` 表示 stdin」的约定，静默吞掉它会让 `sub update -` 落成无参形态批量更新、`start -` 静默起默认代理；它也建不出 remove/use 能指定的订阅名（`getNonFlagArg` 把 `-` 开头 token 当选项跳过）。`-` 前缀 token（`-my-sub`）同由未知选项拦截——handler 层不再需要第二道名称守卫（positional-args.spec 锁口径）
- 其余低危项（接受或不可自动化）：`unhandledRejection` / `uncaughtException` 已统一口径但渲染函数本身不可注入测试；`NO_COLOR` / stderr 设色经 pty 手工验证、无自动化；`FORCE_COLOR` 不支持、`TERM=dumb` 仍出色；无 `--` 结束选项约定（当前无需要它的入口，订阅名已禁止 `-` 开头）；gh 资产名未拦前导 `-`（仅 GitHub API 被篡改时可达）；代理探测 curl 未加 `--proto =https`（只看 204 无机密）；`npm_config_proxy` 等 npm 专属代理变量不处理——npm 读 npmrc 不依赖该 env、gh/curl 不识别，不构成下载死锁

## 只能手工验证的范围

这些路径要么会留下永久记录、要么依赖真内核或真提权，开发机与 CI 不自动执行；对应的测试方法纪律见 [开发约定](docs/development.md#自动化测试边界)

- 真实 sudo/TUN 与完整服务 start/stop 不进自动化：前者修改路由、需要密码且可能留下 root 属主文件；后者的 enable/disable 会在 disabled 表给每个临时 label 留永久记录，launchctl 无清除动词（disabled 位的持久化细节见「平台与 launchd」）。服务层 launchctl 路径由 PATH 桩覆盖；sudo 侧的测试覆盖见下条
- install 恢复分支的并发：只能在真装了内核的机器上手工双终端复现；自动化要么真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。热重载成功与查询失败回退已由 service-concurrency.spec 用 PATH 桩覆盖
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- 入站/控制面锁定清单的内核侧行为：unix socket 创建、TUIC/SS/Vmess server bind、`allow-lan: true` 下内核是否真绑全网卡等，只回上游源码核对了键名与启动前提、用 `buildConfig` 实测了剥除（config.spec 全覆盖），**没用真内核验证额外监听真的开不出来**。不是待办：主力开发机按设计不装内核，要验得换一台装了内核的机器

## 已评估未采纳

本节只存单模块、呈现层或工具链层面「不做」的评估；跨模块架构决策与其拒绝的替代方案归 [decisions.md](docs/decisions.md)，不在此重复

- **全局 `--verbose`**：终端输出散在各模块，全局开关需要横切 argv 与输出层，收益不明；排查已有 `doctor`、`logs`、`status --json`
- **用 `util.parseArgs` 替换手写 argv**：可选值选项（`--mirror`）、attached 短选项（`-n200`）、`--opt=value`、裸 `-` 拒绝与定制中文报错无法对齐；已收口为带值选项共用 `collectFlagValues`（flags.ts）
- **npm `preuninstall` 钩子**：npm 不执行 uninstall 生命周期（npm 11.19.0 三场景实测 + 官方文档注明未实现），卸载提醒只能靠 README 的顺序说明，别指望恢复钩子
- **去 tsx 换 Node 原生 type stripping**：本仓 import 用 `.js` 扩展指向 `.ts` 文件、原生不重写扩展名，需全仓机械改写 + `allowImportingTsExtensions`，收益仅省一个 devDep；除非哪次大重构顺路，否则不做
- **轻量 import 结构断言**：用静态 import spec 断言「非 commands 生产模块不得 import commands」与「生产 import 图无环」。只锁依赖边界、不冻结文件清单或职责；当前没有真实循环依赖，下次新增核心模块时再评估
- **名为 `help` 的订阅 `use` 撞车**：频率极低、`sub use help` 可用、动 argv 拦截的风险大于收益
- **lsof 多 pid 取第一个**：误判方向是回退 kickstart，保守侧
- **README 不逐一罗列裸 `-v` / `-h` 与 logs 的 `--follow` / `--open` 长形式**：与各命令帮助行同口径，短形式优先；完整选项以对应帮助为准
- **curl `-x` 与控制器 base URL 不并入 `loopbackHttpUrl`**：拼接语义不同（curl 代理地址 / 控制器 base URL），共用只会制造耦合
- **不建 README↔registry 文本同步 spec**：README 命令表与 registry usage 是有意的双份形态（registry 是 CLI 帮助的唯一真相，README 是承诺文档），跨格式模糊匹配比它防的漂移更脆；registry 内部口径一致由 help.spec 锁，复杂行为只在 README 一处详写、其他位置链接
- **「ports 配置非法」三处降级措辞不抽共享常量**：status（省略控制器后缀）、ui（整行换说法）、doctor（专项检查带修复指引）是三个展示语境的刻意分档，不冻结成同一文案
