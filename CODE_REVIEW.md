# 代码审查：现行结论与边界

规则见 CLAUDE.md，决策论证见 docs/decisions.md，版本历史见 CHANGELOG。本文只保留**现行有效**的三样东西：实测结论、未覆盖风险、流程教训。历轮审查的逐项验证流水不在此堆放——看当轮 CHANGELOG 条目与 git 历史；每轮审查收尾时，把仍然成立的结论合并进对应节，过时的删掉。改相关代码时同步更新对应节。

最近审查：2026-10-01，全仓四域复审（服务/进程、配置/覆写、命令层、测试与元数据，四个子代理并行深审 + 主仓实跑）共修 7 项：sudo 超时改抛超时错误（不再漏 ETIMEDOUT 串）、SECURITY 移除已删除 tar 防线的描述、match 值加载期校验（url-domain 裸域名/name 字符集 + rules!+、+~rules 漏网形态）、帮助文案对齐（logs/version/sub use）与子命令名大小写归一、零消费者导出收口与 StopResult.killed 删除、CHANGELOG 1.x–3.x 原样归档 docs/changelog。全量验证 typecheck / Biome（98 文件，仅 1 个既存 noProto warning）/ build 全绿。四项修复与导出收口、CHANGELOG 归档一并发布为 26.10.97；发布区间第三轮复查另修 formatTimestamp 非法值（770 测试），同版本带出。

前一轮审查：2026-10-01，全仓复审（三路模块深审 + 用户接触面实跑）共修 16 项：覆写文件级错误诊断一致性、doctor/status 文案、死代码四删（withFileLock deadline 分支、forceSudo、uninstall 双 disable、测试专用 deepMergeWithOverrides）、残留内核清理统一到 cleanupAll、健康轮询关闭 print-disabled，以及六项体验打磨（超时订阅按跳过渲染、kernel/.tmp-* 清扫、零订阅口径、reset 近失提示、gh 回退明示、探测 3s 缓存）；合入后复查修掉清理统一引入的两处语义回退（无害 pid 文件让非 TTY stop 失败、uninstall user 残留退出码被收紧），处置判据抽 classifyResidueCleanup 锁四象限，并收窄 .tmp- 清扫只认 kernel/。上述 16 项发布为 26.10.95。其后复审 pid 清理链路并收口：两个提权脚本里的 `rm pid` 字面例外（buildKernelCleanupScript、legacy 迁移 buildLegacyCleanupScript）先后移除，pid 删除统一到「复核零进程才免提权 unlink、活进程保留」判据；同期拆分 CleanupResult 的脚本/pid 双错误字段、拦截裸 `-`、修正多处残留归因，发布为 26.10.96。上一轮 16 项见 26.9.93/26.9.94 CHANGELOG。全量验证 typecheck / 751 测试 / Biome（94 文件，非 0，仅 1 个既存 noProto warning）/ build 全绿。

## 已有验证仍支持的结论

以下结论来自既有测试或真机实测，引用时注意各自的验证条件：

- 原子写临时名带 pid 与进程内序号；锁释放校验所有权，陈旧锁可恢复，根目录锁不会被 runtime/subscriptions 重置带走（paths.spec）
- YAML 解析保留共享引用与锚点，JSON 无需第二套解析；match 为空或键名错误时拒绝加载（config/overwrite 测试）
- process-probe.spec 调真实 pgrep 验证 POSIX ERE；process-stop.spec 用路径隔离的桩进程跑真实 pkill，覆盖批量清理与 PID 复用
- service-exitcode.spec 只读调用真实 launchctl，确认 113 未装载、112/125 查询失败；service.spec 验证顶层字段、信号死亡与停止计数判据
- root-guard.spec 验证入口在创建数据目录前拒绝 root；用户态 LaunchAgent 无权创建 TUN
- launchd 的 terminating signal 与 last exit code 两字段互斥；需要 describeExitCause 同时覆盖
- disabled label 的 bootstrap 硬失败，enable 必须在前；bootstrap 返回 0 不表示内核已健康，TUN 的 kill -0 也不能排除僵尸进程
- 内核四种下载通道曾各自下载真实产物；kernel.spec 覆盖通道选择、标准资产选择、curl/gh 参数纯函数。资产形态按上游 v1.19.30 实测只有单文件 `.gz`（gzip 解压，maxBuffer 256MB 即体积上限），tar 设施已移除；非 `.gz` 资产显式报错
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- 覆写文件级校验（已移除操作符/互斥/空键 + 数组操作符命中 BASE_CONFIG 非数组键）在 readOverwriteFiles 加载阶段执行：诊断旁路（ow/status）与合并闸门（start/config/doctor）看到同一份 broken 列表，坏文件的 hint 在三处文本与 status --json 都带出；依赖订阅当前值的冲突仍只在合并期报错（ow 不绑定订阅）
- 残留内核清理唯一入口是 cleanupAll（process-stop.ts）：stop/start/uninstall/reset 四个路径共用，root 残留走一次 sudo 脚本 buildKernelCleanupScript（只 pkill、不删 pid 文件），发信号后统一 5s 死亡等待再复核 pgrep——服务路径曾在发信号后立即复核、收割稍慢时误报「部分进程未终止」，随统一消除；sudo 取消/脚本失败经 CleanupResult 的 scriptError（pkill 脚本）与 pidError（pid 文件删除）两字段独立带出——进程死光但脚本没走完与仅 pid 文件残留是两种归因，合并成一个字段会让调用方提示说错事。**pid 文件清理免提权**：文件在 runtime/（用户属主目录、无 sticky bit），目录可写即可 unlink 其中任意文件、与文件属主无关，root 属主的 TUN 残留也直接删——走 sudo rm 是误把「文件属主」当成删除权限判据，白弹管理员密码；但 cleanupAll 路径**仅在复核 remaining 为空时才删 pid**：pid 文件是 isRunning/status 的真相源，sudo 被取消、root TUN 仍在路由时删文件会让 status 对活着的内核报「未运行」。该路径的提权脚本 buildKernelCleanupScript **只 pkill、不碰 pid**——旧实现在脚本里无条件 `rm pid`，仅靠「sudo 取消脚本不执行 + pkill 失败 exit 2」两道时序间接保证不删活进程，是该不变量在 cleanupAll 路径的字面例外，现已移除；root 属主文件由末尾免提权 unlink 收走（stop() 零进程分支也直接 clearPid）。**另一条提权路径 buildLegacyCleanupScript（清理旧 v3–v4 root LaunchDaemon）同样不碰 pid、现已收口**：旧实现在 `launchctl bootout` 之后无条件 `rm -f pid`，机器同时残留旧 plist（detectLegacySystemInstall 只查文件存在、不要求任务在跑）与无关活 root TUN 时，bootout 返回 113（未装载）后仍会删掉活 TUN 的 pid——到进程真正被收掉之间的窗口里并发 `mihomo status` 对活 TUN 误报「未运行」，此刻 Ctrl+C 则凝固成「活 TUN + 无 pid」。现把脚本里的 rm 移除，pid 改由 cleanupLegacyInstallOrThrow 在 root 拆除成功后经 reapPidWhenQuiet 收口：等 launchd 收割后再复核 pgrep，**零进程才免提权 unlink，有并存的活 TUN 则保留其 pid**（status 真相源）。一处包装收口，stop/start/install/uninstall/reset 五个调用点都经它（函数改 async、调用点 await），不再逐点补兜底；零进程但删除失败只警告、下次 stop 再清。buildTunLaunchScript（TUN 启动）的 `rm pid` 是 pkill 旧实例后立即写新 pid 的自管流程，不在此列。服务层的处置判据唯一收口在 classifyResidueCleanup（service.spec 锁定三档及各字段组合）：root 清理失败且进程仍在（remaining + scriptError）→抛；无残留进程但有收尾错误→警告不拦命令（无进程读它、下次自愈）；用户态残留（remaining 非空、无 scriptError，含仅 pidError）→本层不抛，cmdStop 抛「部分进程未终止」、cmdUninstall 黄色提示退出 0、start 由健康确认兜底——pidError 是免提权 unlink 的小错，不参与 throw 分档。root 文案由 buildRootResidueCleanupError 按字段归因：remaining 的属主断言只跟随 scriptError（root 脚本没走通才说 root 残留）；remaining 为空时 scriptError 优先于 pidError——两字段并存（脚本没走完且文件也没删）时主归因随脚本、pid 错误仅附带，手动命令给 pkill 而非 rm（防漏掉潜在存活进程）；pidError 文案只说「未能清理」+具体错误、不断言属主；sudo 失败短语全仓共用 describeSudoFailure（非鉴权错误保留原始 message），pid 文件短语共用 describePidCleanupFailure——各写一份会漂移出多种说法
- waitServiceHealthy 轮询用 getServiceStatus({withDisabled:false})：健康判定不读 disabled，每轮只发一个 launchctl print（最坏 31 轮不再白跑 print-disabled）；循环外无首次快照（第一轮 sleep 后必覆盖）
- withFileLock 强夺唯一判据是锁龄：deadline 等待上限分支是零行为残留（同谓词在循环顶部微秒前刚算过），已删；uninstallService 只在锁内 disable 一次（锁外第二次必成功，是冗余且双 bump）
- 自动更新整体超时（abort）的订阅按「跳过（使用本地缓存）」灰字渲染、不计 failed；真实网络失败仍是红叉（subscription.spec 锁三档）
- kernel/.tmp-* 下载临时目录与 *.tmp 原子写文件同受 cleanupStaleTmpFiles 按 1h 龄清扫（下载硬超时 180s，4 倍余量）
- 连通性探测按端口缓存 3s（代理状态秒级不可翻转），连敲 status/doctor 第二次免等；--no-probe 不经缓存
- 覆写 DSL 已裁边：`~`/`~?`/`<x>` 转义与 match 的 `subscription` 同义键移除，按 name 合并数组元素这类带条件的变换改由 JS 脚本承担（全信任模型同 `.zshrc`，同步函数、锁定键在脚本后剥除并告警）；移除形态显式报错给迁移指引。不在 CLI 复制一份分组必填字段校验（字段集随内核漂移），残缺元素仍由 `-t` 拒绝
- 原生 `-t` 只验证配置解析，不能证明节点可达、端口可绑定或真实 TUN 路由正常；服务健康与代理连通性检查仍有独立价值
- `sudo pkill -f <PATTERN>` 不会匹配 sudo 脚本自身的命令行：`escapeRegExp` 把点转义后，进程命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点，恰好坏掉自匹配（对照实验：把 `\.` 换回 `.` 立即自匹配）。三个 root 脚本同此结论，不加行首锚；未来若改用未转义拼接必须重验
- doctor 耗时大头是 `npm view` 纯网络往返（隔离实测 782ms / 全程 839ms，其余检查合计 74ms），已改为开头发起、末尾 await 并行等待；未装内核时并行收益趋零是 npm 查询本身的固有下界，不是实现问题
- 顶层未知键内核**不拒**（真内核 -t 实测 `enabled: false` 照常通过）——剥离元数据键完全是 CLI 的责任，没有内核兜底
- `status --json` / `config --json` 的 stdout 在空环境、设置损坏告警期、有 warnings 三种场景下始终可整体解析，告警一律走 stderr（三场景各实测过一次）

## 未覆盖与待复核

- **remove/add 并发同名订阅的孤儿 yaml**（记录不修）：subAdd 的下载刻意不持 settings 锁（60s 下载不能压进临界区），A remove 完整提交时 B 的 yaml 尚未写出 → postCommit rm 落空 → B 随后写盘。终态「条目已删、孤儿文件残留」，无行为消费方（grep 证实无 subscriptions/ 目录枚举），仅 `dir open subs` 可见。要封死需下载完成后二次确认归属，收益不抵复杂度
- **stop 游离路径批量 pkill 与并发 start 的交错**（记录不修）：B 读 status（未装载）→ 并发 A bootstrap 并拉起服务内核 → B 读 pids 命中 A 的内核 → stop() 的 cleanupAll pkill 杀掉它，KeepAlive 约 10s 拉回（游离路径不 bootout）。B 报「已停止」与终态相反。与已接受的「探测与动作之间隔一次查询」同族（TUN sudo 窗口），方向相反（stop 伤 start），触发要求两次读取之间落入对方的 bootstrap+进程拉起，记录不修
- **TUN 启动的亚秒窗口内并发 stop 删 pid 文件**（记录不修）：TUN 启动脚本写完 pid 文件、内核尚未出现在 pgrep 的窗口内，并发 stop/reset 的零进程分支会删掉刚写的 pid 文件 → startTun 末尾 getPid() 为 null，把成功启动误报成「TUN 启动失败」。与上一条同族（探测与动作隔着一次查询），窗口亚秒级且旧 sudo 版同样存在（TTY 输密码即删），封死需要 start/stop 共享锁（跨进程锁在数据根目录、进程启动不在锁内），收益不抵复杂度
- **文件锁 stat→unlink 两步、不复核 inode**（已知理论缺口）：仅在等待者被冻结（合盖/换出）且系统时钟前跳时可利用，微秒级窗口，不为此加机制
- **sudo 密码窗口内 Ctrl+C 最长 60 秒无响应**（已知权衡）：三处提权（TUN 启动/残留清理/legacy 清理）的 `spawnSync('sudo', …, {stdio:'inherit', timeout:60s})` 阻塞主线程，期间信号处理器无法执行——与 process-stop.ts 头注释「轮询必须 async 保障 SIGINT 可达」的预期在此窗口相悖。改异步 spawn 需自行处理 sudo 子进程回收与 TTY 归属，复杂度远超收益；超时上限 60s 有界，非死锁，记录不修
- **ui 命令的 getRunningState 查询无容错**：launchctl 瞬时失败会把 `ui` 挡死报「无法查询服务状态」，与已修的 status/start 收尾同族；但 ui 是纯打开操作、失败重跑成本为零且打开后不再依赖该查询，按 status 修复前的同一姿态记录不修——若将来 ui 增加依赖运行态的分支，先补容错
- **上游 MetaCubeX/mihomo 的默认分支已变更为 main，且 main 是一个同名 Python 项目**（2026-09-30 起，pushedAt 与 description 均证实）；内核源码与发布仍在 Meta 分支，release 由 github-actions 持续发布（v1.19.31/v1.19.32）。**对 CLI 无影响**：版本查询与下载走 releases API（tag 固定，资产 URL 不变，D8 的来源钉死不受默认分支影响）；受影响的是任何不带 ref 的 contents/tree API 调用——拿到的是 Python 项目。上游源码核对（锁定清单对表）必须带 `?ref=Meta`（config-inbound-snapshot.spec 的引用已带）。若未来 release 停止更新或资产消失，再评估换源
- **锁定清单已于 2026-10-02 对照 v1.19.32 重新核对**：config.Inbound + RawConfig 入站/控制面键集与 v1.19.30 快照无差异（新增面孔 clash-for-android/etag-support/keep-alive 家族/ntp/global-* 均不开监听），快照版本标注刷新为 v1.19.32
- **原子写 fsync 的文件系统边界**：非常规文件系统（如 NFS home）上 fsync 可返回 EINVAL，使原本 rename-only 能成功的写入整体失败——macOS APFS 实测无问题，未在其他文件系统实测。保证范围分层写在 atomicWriteFileSync docstring；崩溃遗留 `*.tmp` 的清扫在三道守卫与豁免判定**之后**执行（清扫是删除动作，不在被拒绝/豁免的命令上跑）
- **remove 时序修复无自动化回归测试**：写盘失败无法黑盒注入，postCommit 回滚删除刚写 yaml 的链路只用例锁住两侧不变式（终态守护 + 未命中不删文件），该修复本身靠代码审查
- **订阅侧 own `__proto__` 刻意不拦**（探针实测）：js-yaml 解析订阅顶层 `__proto__:` 得 own 键，经展示 walk（defineProperty 绕原型 setter）与 dump 均不炸，内核按未知键忽略；只有覆写**合并层**在操作符解析后拦截（覆盖 `__proto__!` 等形态），订阅侧透传是承诺行为
- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。已修；热重载成功分支（PATH 前置桩 launchctl + 桩 controller）与查询失败回退分支（计数桩 launchctl）均已自动化（service-concurrency.spec，不碰真实 launchd），install 恢复分支仍只能手工复现
- 控制器/入站家族锁定（external-controller-tls/-unix/-cors/-doh、tuic-server、ss-config/vmess-config、listeners/tunnels、tls 段、allow-lan 与鉴权家族）只回上游源码核对了键名与启动前提、用 buildConfig 实测了剥除，**没用真内核验证过额外监听真的开不出来**；unix socket 文件创建、TUIC/SS/Vmess server bind、`allow-lan: true` 下内核是否真的绑到全网卡等内核侧行为同理。**这不是待办**：主力开发机（Mac mini）按设计不装内核（见「平台实测备忘」末条），要验得换一台装了内核的机器，与 launchd 真实启停、TUN 提权同属「只能在别的机器上手工复现」那一类。剥除行为本身由 config.spec 全覆盖，内核侧只是第二道确认
- **锁定清单的完整性此前靠人肉对表，v4.13.0 起有了半自动兜底**：`config-inbound-snapshot.spec.ts` 冻结了一份带上游版本号的 `config.Inbound` 字段集，差集必须逐项写明放行理由，否则测试红。**但快照发现不了上游新增字段**——上游加了新入站键，这里不会红，照样漏；它只把「凭记忆重新推导整张清单」降级成「拿结构体 diff 一份已存在的清单」。内核大版本升级时必须人工刷新快照（CLAUDE.md 已记）。历史：redir/tproxy（4.9.0）、-tls/-unix/-doh 与 tuic-server（4.9.1）、ss-config/vmess-config（4.9.2）、listeners/tunnels（4.12.0）、allow-lan 与鉴权家族（4.13.0）**五轮各漏一批**，每轮都以为「这次逐个核对过了」——第五轮漏的那批还是「曾被写进注释提醒别当兜底、却始终没锁它自己」的键
- **锁 `authentication` 的代价（v4.13.0 引入，待观察）**：剥除来源盲，故用户也不能再用覆写给 Mixed 端口设代理鉴权。缓解是 `allow-lan` 已强制 false、Mixed 只监听回环，主要威胁面（局域网）已消失；残余是同机其他进程（含浏览器网页），与控制器默认无鉴权同一量级。控制器侧有 `controller_secret` 逃生口，Mixed 侧暂无——真有人需要再加 settings 键，不提前造开口
- `iptables`、`inbound-tfo`、`inbound-mptcp` 仍原样进运行配置：前者是 Linux 专用的系统集成开关、非监听，darwin 内核无该路径；后两者是 TFO/MPTCP 传输层 socket 选项，不开监听、不改绑定地址、不绕鉴权。config.spec 有用例锁住现状，决策改变时会明确失败而不是悄悄漂移
- 锁定告警只对覆写文件：覆写经操作符设置锁定键（如 `+secret`）已覆盖，但覆写文件内 `match:` 块之后、且文件解析失败被 warn 跳过时不会有告警（文件整体没生效，合理）
- 订阅名匹配**不引入通用匹配器**（历史教训：glob「转义成正则再 test」的实现实测 `*a`×20 配 64 字符订阅名跑 70 秒——长度上限内的合法输入就能挂死 CLI；换双指针贪心回溯后同一输入 0ms，30 万组差分与正则版一致）。本轮进一步裁边：只保留尾部 `*`（前缀）与头部 `*`（后缀）两种字面比对形态（`startsWith`/`endsWith`，无回溯结构），其余通配（多 `*`、中间 `*`、`?`、单独 `*` 恒真）加载时报错，复杂匹配走 JS 脚本。教训仍在：输入面受控不能替代实测，通用匹配器复活前先想 70 秒这次事故
- 裸 `-` 在 argv 层按未知选项拦截、不豁免：本 CLI 没有「- 表示 stdin」的约定，静默吞掉它会让 `sub update -` 落成无参形态批量更新、`start -` 静默起默认代理；它也建不出 remove/use 能指定的订阅名（getNonFlagArg 把 `-` 开头 token 当选项跳过）。`-` 前缀 token（`-my-sub`）同由未知选项拦截——handler 层不再需要第二道名称守卫（positional-args.spec 锁口径）
- 单个覆写文件的 `enabled` 写错会让 `mihomo status`、`ow` 整体失败（经 `listOverwriteFile` → `loadOverwriteFile` 抛 CliError）。与 `match` 写错的现有行为一致、不是新退化，可接受的前提是错误消息带文件名（已有用例锁住）
- 元数据键的操作符拦截覆盖 `parseOverrideKey` 能识别的全部形态，**含尖括号转义**：`<enabled>` 同样报错（实测）。代价是失去了「写一个真名为 `enabled` 的配置键」的逃生口——mihomo 顶层目前没有这个键，故暂无影响；若上游将来新增，需要在 `assertNoMetadataKeyLookalikes` 里为尖括号形态开一个口子
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- startTun 的日志轮转已挪到存在性校验之后，但 sudo 取消路径仍有一个同类窗口：轮转（rename 归档）到 pkill 实际执行之间用户取消的话，仍在运行的旧 TUN 内核会继续往归档文件写。rename 进不了 root 脚本（归档命名/清理在 TS 层），接受——下次成功启动自愈，logs 列表短暂缺当前日志
- TUN 分支 bump 的快照取自命令开头，而 `cleanupLegacyInstallOrThrow()`（遗留 root daemon 存在时）有最长 60s 的 sudo 密码窗口隔在快照与 loaded 守卫/bump 之间：窗口内并发的 mixed start 完成启动后，TUN 随后 bump + startTun 复核中止，mixed 侧健康确认后的 epoch 复检会报「启动已取消……已按最后一条命令保持停止」——该文案在此交错下失真（服务实际健康运行，TUN 未启动）。触发需要遗留 root daemon 存在 + 精确交错，概率极低；与 stop 的 bump 不同（stop 的 bump 在锁内伴随 bootout），TUN bump 无 bootout，「中止时服务已装载」是该路径独有形态。终态正确（服务运行），仅文案失真，记录不改
- TUN 方向的并发防线也有同族残余：startTun 复核点到 sudo 脚本内 pkill 实际执行之间隔着密码窗口，pkill 在 root 脚本内进不了锁。两道防线合起来覆盖了「B 在 A bump 之前/之后进锁」两种交错，但「B 恰在 A 复核后、pkill 前完成 bootstrap」的毫秒级窗口仍在——B 出锁前锁内 epoch 检查读的是 bump 后的值会放弃，故该窗口要求 B 的整个 enable+bootstrap 压进 A 复核到 pkill 之间，实际可达性极低，与 kickstart 锁外交错同级接受
- 锁内 launchctl 调用有持锁预算（最坏总时长 < `LOCK_STALE_MS`）：start 侧正常 enable+bootstrap 两次 6s、失败分支三次 9s，stop 侧 bootout+disable+复核共三次，单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s），别再往任何锁内加东西。锁内三环节（复核先于递增、递增在锁内、bootout 与 disable 同锁）谁也挪不出锁，缩减调用次数的路走不通，理由见 service.ts 该常量注释
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- 测试只依赖 macOS 自带命令（bash/launchctl/pgrep/pkill/lsof/gh）与 node 自身（bash 仅作桩脚本的 shebang）。doctor 的计时桩一度用 `python3` 取毫秒（`date` 不支持 `%3N`），是全仓唯一的外部依赖孤例，已改用 `process.execPath -e "Date.now()"`——跑测试的解释器必然在，路径也确定。新增测试桩需要取时间/做计算时照此办理，别再引第二个运行时
- `config` 命令不做内核校验，故它能输出「形态合法但内核会拒绝」的配置（例如引用了不存在的节点）。这是刻意的分工——校验归 `doctor` 与 `start`，只读展示不该要求装了内核
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路只能真机 sudo 验证：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受之；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- TUN 运行中 `sub use`/`ow` 的按原模式重启与更新提示（`start tun`）已修，但真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未复测，仅经 runtime.spec 的桩内核路径验证决策
- 深审其余未修的低危项：`unhandledRejection`/`uncaughtException` 已统一口径但渲染函数本身不可注入测试；`NO_COLOR`/stderr 设色经 pty 手工验证、无自动化；clearProxyEnv 对企业 env 代理网络的影响已文档化（CLAUDE）但无提示机制。`npm_config_proxy` 等 npm 专属代理变量未清——npm 读 npmrc 不依赖该 env、gh/curl 不识别，不构成下载死锁，保持现状
- 曾记录但未修（判定接受或不可自动化）：`FORCE_COLOR` 不支持、`TERM=dumb` 仍出色；无 `--` 结束选项约定（当前无需要它的入口，订阅名已禁止 `-` 开头）；gh 资产名未拦前导 `-`（仅 GitHub API 被篡改时可达）；代理探测 curl 未加 `--proto =https`（只看 204 无机密）
- npm 不执行 uninstall 生命周期钩子（npm 11.19.0 三场景实测 + 官方文档注明未实现），preuninstall 设施已删除——卸载提醒只能靠 README 的顺序说明，别指望恢复钩子（README 卸载段已如实写）

## 已评估未采纳

- **全局 `--verbose`**：输出散在 24 个模块的 265 处直接 `console.*`，无中心化日志层；且选项按命令白名单校验（`assertKnownFlags`，14 处），全局开关要么加满 14 个白名单、要么在 index 集中剥离——横切改动大而收益不明。排查已有三条路径：`doctor`（体检加修复指引）、`logs`、`status --json`。真要做，先建日志层再谈开关
- **名为 help 的订阅 `use` 撞车**：频率极低、`sub use help` 可用、动 argv 拦截的风险大于收益
- **lsof 多 pid 取第一个**：误判方向是回退 kickstart，保守侧
- **cleanupAll 的 killedCount 在 pkill 退 1 时记满**：仅测试消费

## 自动化测试边界

真实 sudo/TUN 会修改路由、需要密码并可能留下 root 属主文件，开发机和 CI 不自动执行

完整服务启停测试也不默认运行：enable/disable 会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 给每个临时 label 留永久记录，launchctl 无清除动词；只用 bootstrap/bootout 的一次性 label 可以临时验证有限的 launchd 行为，但不能覆盖 stop 的全部语义。要驱动服务层的 launchctl 路径时用 PATH 前置的桩 launchctl（service-concurrency.spec 的做法）：代码走真实路径、真实 launchd 一点不被碰，配 HOME/MIHOMO_CLI_DIR/一次性 label 三层隔离

进程与 reset 测试必须验证隔离前提：临时 MIHOMO_CLI_DIR 限定进程路径，独立 MIHOMO_CLI_DAEMON_LABEL 限定 plist/服务查询；仅隔离数据目录不足以保护用户服务

doctor 的内核版本项与 npm 查询项取值依赖网络（GitHub 可达性、限流），用例只锁检查项存在，不写死 ok/warn/skip

子进程 + 本地桩 server 的用例必须**异步 spawn**：spawnSync 会阻塞父进程事件循环，桩 server 无法 accept、子进程 fetch 挂死（父子死锁，实测 30s 超时零请求到达桩）

## 平台实测备忘

- kickstart -k 可能阻塞超过 5s，当前使用独立的 60s 超时；bootout 未装载目标返回 3
- KeepAlive.PathState 只决定退出后是否重启，删除标志文件不会主动停止进程，不能用来替代 stop
- disabled 位独立于 plist 持久化，enable 也留记录；手工移除需 sudo plutil，keypath 的点须转义，磁盘修改要重启后才与 launchd 内存一致，不能做进 CLI 自动清理
- BSD ps command 列需 -ww，stat 用 -f%z；open 是异步桌面操作，返回后才可能失败，调用方保留手动路径
- 未装内核的开发机是正常环境，不能为了检查自动安装用户服务或提权；真机结论可能来自其他测试机器

## 文档与流程复盘

稳定约束集中在 CLAUDE，历史保留在 CHANGELOG/git

v4.9.2 的教训是关于本文自身：**「已核对」的记述会被后人当成已核对，从而关掉这条线索**。v4.9.1 写下「键名逐个回上游 General 段核对」时并未真正遍历 `Inbound` 字段集，而这句话此后成了不必重查的理由。此类声明要落到可复现的对表方法（照哪个结构体、哪个函数的入参），不写「逐个核对过」这种无法复核的完成态；写完再回头验一遍声明本身是否属实

发布后也要回头改状态：v4.9.1 发布后本文仍留着「待发布」和旧的测试数（596，`d4eb38b` 补 3 条后没同步）。release 流程第 9 项（发布后收尾）要求同步本文档，实际漏的是**发布动作完成之后**那次状态更新。v4.12.0 又漏了同一处——发布八步全走完、还从 registry 拉回产物验过六项行为，唯独本文头部仍写着「未发布」。同一条教训两次栽在同一个位置，说明「记在复盘里」不够：它不在发布清单上，就不会被执行。写在这里的教训，如果对应一个具体动作，就该同时落进清单

v4.10.0 的教训是**测法本身也要验**：用 `mihomo config tun` 去测 TUN 模式下元数据是否泄漏，但 `config` 不接受模式参数——命令其实报了参数错误，「0 条泄漏」只是因为压根没输出配置。同一轮里还拿订阅自带的节点名 `TW Fixed IP` 当 e2e 探针（真实订阅里出现 5 次，断言恒真）。两次都是**假阳性**：测试跑绿了，但绿的原因不是被测功能。手工验证一个「没发现问题」的结论时，先确认该测法在功能坏掉时会红——与本仓对自动化用例的反向验证要求同一条纪律，手工验证不该豁免

类型检查曾漏掉测试字符串内对已删除导出的引用，已修正并把全仓搜索要求写入 CLAUDE；发布流程的注册表示例也同步去掉了失效字段

v4.12.0 的教训是**「待定」不是中间状态，在实现上等于放行**：`listeners`/`tunnels` 从 v4.9.0 起被记为「未定的产品决策，两者须一起评估」，此后三轮补漏每轮都逐个核对入站面，却因为这两个键**已经有归档结论**而跳过——「待评估」的标签让它们看起来是被处理过的，实际是三个版本里订阅想写就写。config.spec 那条「待定入站面」用例更强化了这种错觉：它锁的是「原样保留」，跑绿只说明现状没漂移，不说明现状是对的。教训有二：① 安全边界上不留「待定」，要么锁要么写明「刻意放行 + 理由」（`iptables` 就是后者）；② **锁住现状的用例不等于验证过现状**——写这类用例时要在注释里说清它锁的是决策还是正确性

同一轮另两处（status 把主文件显示成 `yaml`、提示指向不存在的 `kernel --help`）都是**只读一遍代码看不出、跑一次就现形**的问题，且都落在刚被重点打磨过的区域。复审时除了读代码，把主要命令在隔离数据目录里实跑一遍，成本极低

v4.13.0 的教训是「反向验证的预测错了，比预测对更有价值」：计划里写「把 `allow-lan` 塞回 `BASE_CONFIG` 应转红」，实测 700 条全绿。原因是 `systemConfig` 的赋值无条件，BASE_CONFIG 里那份直接成了**死配置**——既不报错，也无任何行为差异。如果当初只按计划「确认它红」就收工，这个静默的死配置会留在表里。教训有二：① **反向验证要真跑，不能因为「理应会红」就跳过**——预测落空处往往正是认知与实现的偏差点；② 死配置比缺陷更难发现（缺陷会报错，死配置什么都不说），发现后应补不变量用例把它挡在结构层，而不只是改掉当前这一处。现由 `config-inbound-snapshot.spec.ts` 断言两表无交集

同一轮还有一处「五轮漏键」的新形态：`allow-lan`/`bind-address` 早在 v4.9.2 就被写进注释和测试名（「别拿 allow-lan 当兜底」），却从没人问过「那它自己锁了吗」。**被写进防线说明里的键，看起来就像已经被防线覆盖了**——与上一轮「待定标签让人以为处理过」是同构的错觉，只是载体从归档结论换成了注释。核对锁定表时，注释里出现过的键名不能当作已覆盖的证据，唯一证据是它在不在 `LOCKED_CONFIG_KEYS` 里

**删测试时数用例不能 grep 源码，要跑删除前的基线。** 核对「700 删了多少条」时，静态数 `it(` 模板得到的总数对不上实跑的 643——用例在 `for (const shell of …)` 循环里展开，21 个模板运行时是 25 条。最终用临时 worktree checkout 基线逐个 spec 跑 `ℹ tests` 才核准拆账。与发布流程核对测试数同一条纪律：计数只认真实运行结果

**隔离不是只隔离 `MIHOMO_CLI_DIR`。** 落盘位置经 `os.homedir()` 推导的东西（LaunchAgent plist 在 `~/Library/LaunchAgents`），数据目录变量挡不住，还需把 **`HOME`** 指向临时目录——service-concurrency.spec 的热重载场景就是三层隔离（`MIHOMO_CLI_DIR` + 一次性 label + 临时 HOME）。手工验证涉及 plist 的路径时同样要做，别只设数据目录变量

**计时断言别用墙钟阈值，先问能不能直接观测交叠。** 并发结构的用例先写的墙钟版（桩各睡 N 秒、断言总耗时 < 1.75N）连调两次阈值仍在套件变大后误红——墙钟同时受机器负载、`node --test` 的 suite 并发与 tsx 转译影响，而误红的表现是「并发结构坏了」这种指向完全错误的失败。改为让两个桩各自记录进入/退出时刻、直接断言**两段区间有交集**：与被测性质一一对应，对机器快慢免疫。时序对负载敏感的地方同思路：时序断言只兜「预算内的慢不破阈值」（桩 sleep 留足余量），「调大单次预算 / 往锁内加调用」改由常量关系断言承担（调用次数 × 单次预算 < 强夺阈值），并行 build+test 压测三轮确认

**fire-and-forget 的行为别靠桩文件断言。** spawnSync 子进程退出过快时，其 detached 的孙进程（如 `open`）可能来不及执行，PATH 桩收不到调用——「没收到调用」测不出任何东西。这类断言要抽纯函数测

**测「与 locale 无关」的用例，数据必须选在任意目标 locale 下都分出两种序的组合。** 覆写排序用例第一版取 ['dns','工作','机场']——在 zh 开发机上能咬住 localeCompare 旧实现，但在 en 的 CI 上 localeCompare 与码点序恰好同序，对旧实现**恒绿**：用例锁的是「当前机器的 locale」而不是「码点序」。改为 ['overwrite.B.yaml','overwrite.a.yaml']（任何 ICU locale 的字母序都 a 先、码点序 B(0x42) 先）后才与 LANG 无关。写这类用例前，先在 en/zh/ja 下实跑一遍测试数据，确认它真的分出两种序

**修一条红线要回查它的全部路径，同族漏网按「路径」不按「模块」分布。** 修了覆写**合并层**的 `__proto__`，下一轮在**展示层**（redact）抓到同族；修了 isLoopbackHost 的裸 localhost，下一轮在同一函数抓到 0.0.0.0/::。漏网都不在「没改过的模块」里，而在「改过的判据的另一半消费路径」里。修法：修红线（裸异常按 bug 渲染、自代理死锁）时列出该判据/红线的全部消费路径（合并、展示、下载、诊断），逐条确认，而不是只回看本次动过的文件
