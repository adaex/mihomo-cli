# 现行结论与边界

现行约定从 [CLAUDE.md](CLAUDE.md) 的文档导航进入，架构决策见 [docs/decisions.md](docs/decisions.md)，版本历史见 CHANGELOG 与 git tag（发布状态以 tag 为准，本文不记）。本文只保留**现行有效**的结论：实测结论、未覆盖风险、已评估未采纳、测试边界与平台备忘；当轮验证过程留在提交信息里，过时条目直接删除。改相关代码时同步更新对应节。

## 已有验证仍支持的结论

以下结论来自既有测试或真机实测，引用时注意各自的验证条件：

- 原子写临时名带 pid 与进程内序号；锁释放校验所有权，陈旧锁可恢复，根目录锁不会被 runtime/subscriptions 重置带走（paths.spec）
- YAML 解析保留共享引用与锚点，JSON 无需第二套解析；match 为空或键名错误时拒绝加载（config/overwrite 测试）
- config-graph 用带完成缓存的 DFS + active/completed 分离检查循环与 200 层深度，完成节点缓存展开成本与子树高度，共享 DAG 不按展开体量遍历，深处复用浅处缓存也不会漏掉实际路径深度。100000 展开节点预算只服务 config 脱敏与 JSON（含 --reveal 的单独预检）；下载、start、内核校验只查循环与深度，不套展示预算（config/redact/commands/config 测试）
- process-probe.spec 调真实 pgrep 验证 POSIX ERE；process-stop.spec 用路径隔离的桩进程跑真实 pkill，覆盖批量清理与 PID 复用
- service-exitcode.spec 只读调用真实 launchctl，确认 113 未装载、112/125 查询失败；service.spec 验证顶层字段、信号死亡与停止计数判据
- root-guard.spec 验证入口在创建数据目录前拒绝 root；用户态 LaunchAgent 无权创建 TUN
- launchd 的 terminating signal 与 last exit code 两字段互斥；需要 describeExitCause 同时覆盖
- disabled label 的 bootstrap 硬失败，enable 必须在前；bootstrap 返回 0 不表示内核已健康，TUN 的 kill -0 也不能排除僵尸进程
- 内核各下载通道曾各自下载真实产物；kernel.spec 覆盖通道选择、标准资产选择、curl/gh 参数纯函数。资产形态按上游 v1.19.30 实测只有单文件 `.gz`（gzip 解压，maxBuffer 256MB 即体积上限），tar 设施已移除；非 `.gz` 资产显式报错
- gh 回退通道的代理注入是实测结论：入口 clearProxyEnv（D9）会清掉自指 env，不注入时 gh 实际直连（真 gh + 拒绝端口实证报 `proxyconnect`）；现由通道决策给 gh 候选挂代理、buildGhDownloadEnv per-spawn 注入（kernel.spec 锁定）。gh（Go）只认 HTTPS_PROXY/https_proxy，无命令行代理选项
- 上游面板自升级（update_core.go）的 meta-backup 是有意永久保留的旧内核副本：成功路径只 defer 清理 meta-update、从不清 meta-backup（每次升级覆盖写，已核对上游源码）——doctor 只把 meta-update 当真残留告警，meta-backup 按信息项给独立删除口径，绝不与暂存共用一条 rm -rf（合并告警会让面板成功升级一次后 doctor 永久误报，修复命令还会连回滚备份一起删）
- npm（update 的 view/install 与 doctor 的版本检查）的 env 代理恢复机制与判据见 D9（recordClearedProxyEnv 登记原值 + 每 spawn 前 TCP 探活决定注回，不凭空注入）；此处只记验证结论：桩 npm 透传 + 真实本地监听三态用例锁定，反向验证删掉注回即「端口在监听」用例转红、两个反例保持绿
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- readLogTail 必须按 fs.readSync 的实际字节数解码：stat 与 read 之间日志被并发截断/轮转重建成更小文件（copy-truncate、双终端 start/restart）时会短读，按原 size 解码零填充 buffer 会把 NUL 字节打进「内核启动失败」的日志尾部；0 字节返回空（log-files.spec 桩 readSync 钉住 bytesRead 契约）
- 手改缓存的脏值硬化同一口径：参与运算前先 Number 化、非有限值不参与——formatTraffic/formatTimestamp（展示面）、subscriptionUrgency（紧急度与「代理不通」归因）、status 流量行着色（≥90% 黄警）四处同源；upload/download 裸相加遇到字符串会拼接成 `"1234"` 误判流量用尽，数字字符串仍按数值判（settings.spec 与 commands/status.spec 锁定，反向验证转红）
- 覆写文件级校验（已移除操作符/互斥/空键 + 数组操作符命中 BASE_CONFIG 非数组键）在 readOverwriteFiles 加载阶段执行：诊断旁路（ow/status）与合并闸门（start/config/doctor）看到同一份 broken 列表，坏文件的 hint 在三处文本与 status --json 都带出；依赖订阅当前值的冲突仍只在合并期报错（ow 不绑定订阅）
- 残留内核清理唯一入口是 cleanupAll（process-stop.ts）：stop/start/uninstall/reset 四个路径共用，root 残留走一次 sudo 脚本 buildKernelCleanupScript（只 pkill、不删 pid 文件），发信号后统一 5s 死亡等待再复核 pgrep。清理没走完（sudo 取消/脚本失败或 pid 文件删不掉）经 CleanupResult.incomplete 带出：进程仍在则服务层抛错，已清空只警告。**pid 文件清理免提权**：runtime/ 归用户所有，unlink 只看目录权限，root 属主的 TUN 残留也直接删；但**仅在复核 remaining 为空时才删**——pid 文件是 status 的真相源，活进程在时删会让 status 报「未运行」。buildTunLaunchScript 的 `rm pid` 是 pkill 旧实例后立即写新 pid 的自管流程，不在此列
- waitServiceHealthy 轮询用 getServiceStatus({withDisabled:false})：健康判定不读 disabled，每轮只发一个 launchctl print（最坏约 30 轮不再白跑 print-disabled）；循环外无首次快照（第一轮 sleep 后必覆盖）
- kickstart 失败后的回退只在本次 bootstrap 确实成功时进入健康确认；bootstrap 的「已装载」幂等吸收只属于启动与安装恢复路径，不能充当本次重启证据（service-restart-fallback.spec 桩 launchctl 正反两路）
- TUN 在 sudo 返回与启动失败后都复读停止计数；发现并发 stop 时先清理已启动内核，remaining 非空则报停止失败，清理完成后才报启动取消（runtime-tun-concurrency.spec 用假 sudo 在窗口内递增计数并复核进程终态）
- withFileLock 强夺唯一判据是锁龄；uninstallService 只在锁内 disable 一次，不做锁外重复 disable（冗余且会多 bump epoch）
- 自动更新整体超时（abort）的订阅按「跳过（使用本地缓存）」灰字渲染、不计 failed；真实网络失败仍是红叉（subscription.spec 锁三档）
- downloadSubscription 的缓存写失败回滚以写前内容为准：原有 YAML 逐字恢复，仅原本不存在文件时删除本次产物；回滚异常进入提示，不得假报已恢复或已删除。YAML 写入、缓存提交与失败回滚同在 subscriptionCommitLock 内串行，较慢下载的回滚不能覆盖另一进程已提交的新配置（subscription.spec 的本地服务、缓存目录故障与跨进程锁用例）
- cleanupStaleTmpFiles 按 1h 龄清扫原子写 `<目标>.<pid>.<序号>.tmp`、kernel/.tmp-XXXXXX、根目录 check-XXXXXX 与 service.plist.stage；lstat 核对文件/目录类型，名称或类型不符一律保留。全小写六位后缀与 check-backup 等手工目录无法区分，宁可漏扫也不误删（下载硬超时 180s，清扫 1h 有 20 倍余量；paths.spec）
- proxy 连通性探测**不做进程内缓存**：CLI 是单命令短进程，status 与 doctor 从不在同一进程同时发生，每进程至多一次调用，缓存没有第二个读端（与 D10 同前提）；--no-probe 在调用方跳过
- CLI 诊断事件只在入口守卫后的命令上下文中启用，直接 import 底层函数不写文件；同步 O_APPEND 多进程追加逐行可解析，EISDIR 不改变原命令输出/错误。raw/candidate/runtime 哈希配对与仅凭据变化的 hash 差异由隔离订阅和 prepare/commit 用例锁定；热重载成功、PUT 500、PID 不匹配、查询失败与 kickstart→bootstrap 自愈均保留真实阶段结果（diagnostic-events/subscription-prepare/service-concurrency/service-restart-fallback 测试）
- 覆写 DSL 已裁边：`~`/`~?`/`<x>` 转义与 match 的 `subscription` 同义键移除（前者报「已移除的操作符」，后者按未知键报错），按 name 合并数组元素这类带条件的变换改由 JS 脚本承担（全信任模型同 `.zshrc`，同步函数、锁定键在脚本后剥除并告警）；移除形态显式报错给迁移指引。不在 CLI 复制一份分组必填字段校验（字段集随内核漂移），残缺元素仍由 `-t` 拒绝
- 原生 `-t` 只验证配置解析，不能证明节点可达、端口可绑定或真实 TUN 路由正常；服务健康与代理连通性检查仍有独立价值
- `sudo pkill -f <PATTERN>` 不会匹配 sudo 脚本自身的命令行：`escapeRegExp` 把点转义后，进程命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点，恰好坏掉自匹配（对照实验：把 `\.` 换回 `.` 立即自匹配）。三个 root 脚本同此结论，不加行首锚；未来若改用未转义拼接必须重验
- doctor 的 npm、GitHub 版本查询和代理连通性探测在依赖满足后提前发起，到对应展示段再 await；本地配置校验可与网络等待重叠，push 顺序不变。probeProxyConnectivity 全 try/catch 永不 reject，每进程仅一处 await；未装内核时不发起 GitHub 版本查询
- 顶层未知键内核**不拒**（真内核 -t 实测 `enabled: false` 照常通过）——剥离元数据键完全是 CLI 的责任，没有内核兜底
- `status --json` / `config --json` 的 stdout 在空环境、设置损坏告警期、有 warnings 三种场景下始终可整体解析，告警一律走 stderr（三场景各实测过一次）

## 未覆盖与待复核

- **诊断事件是 best-effort，不是审计日志**：append 不做 fsync，SIGKILL/系统崩溃可能丢末尾事件；大小轮转与并发 append 交错时也允许缺事件，不能用缺行证明操作未发生。launchd 登录自启直接拉起内核、不经过 CLI，本轮只覆盖开机前后的 CLI 操作，不记录这一次自启的健康或探测；要补这一跳需另评启动包装/观察器，不改变现有服务入口
- **订阅下载不自动使用 Mixed 或系统代理**：subscription 的 HTTP 客户端是 Node 原生 fetch（http.ts createHttpClient），undici 默认不读 http(s)_proxy/ALL_PROXY（Node 24 需显式 `NODE_USE_ENV_PROXY=1` 才启用 env proxy），也没有按运行态经本机 Mixed 端口转发的逻辑；macOS 系统代理同样不被 fetch 识别。故订阅主机直连不通时 `sub add/update` 可能失败；已有 TUN 路由可接管下载，首次添加仍需能访问订阅地址或换可直连地址。clearProxyEnv（D9）对默认 fetch 路径无影响。若要支持自动经 Mixed 下载是独立特性：undici ProxyAgent 需按运行态注入 dispatcher，且服务停止或未安装时的下载不能无条件依赖自己的端口
- **remove 并发在途 sub update/add 的孤儿 yaml 与 cache 条目**（记录不修）：下载刻意不持 settings 锁（60s 下载不能压进临界区），写盘只认命令开头快照的订阅名、不复核 settings。remove 走完全程（锁内删条目与 postCommit rm，随后删 cache 条目）后，在途下载照写。两个触发形状：add——A remove 时 B 的 yaml 尚未写出，postCommit rm 落空、B 随后写盘；update——A remove 删的正是旧 yaml，B 的在途更新把刚删的文件原地复活。复活的除 yaml 还有 cache 条目（deleteSubscriptionCache 之后 saveSubscriptionMeta 照写回）。add 路径另有文案失真：B 下载完成后 setDefaultSubscription 返回 false 被忽略（subAdd），照打「已添加并切换」。无行为消费方：yaml 只按 settings 里的名字读（requireSubscriptionRawConfig 的 start/config/doctor 三处消费方均从 settings 取名，grep 证实无 subscriptions/ 目录枚举），cache 只按 settings 名字合并（getSubscriptionsWithCache），仅 `dir open subs` 与手翻 cache.json 可见；同名 sub add 覆盖自愈或 reset 清理。要封死需下载完成后二次确认归属（写盘段进 settings 锁、锁内复核条目仍在），但这会打破 downloadSubscription「与 settings 解耦的下载原语」契约——缓存写失败回滚与写盘闸门两套 spec 都拿未入库的 probe 名直接调它，收益不抵复杂度
- **stop 游离路径批量 pkill 与并发 start 的交错**（记录不修）：B 读 status（未装载）→ 并发 A bootstrap 并拉起服务内核 → B 读 pids 命中 A 的内核 → stop() 的 cleanupAll pkill 杀掉它，KeepAlive 约 10s 拉回（游离路径不 bootout）。B 报「已停止」与终态相反。与已接受的「探测与动作之间隔一次查询」同族（TUN sudo 窗口），方向相反（stop 伤 start），触发要求两次读取之间落入对方的 bootstrap+进程拉起，记录不修
- **TUN 启动的亚秒窗口内并发 stop 删 pid 文件**（记录不修）：TUN 启动脚本写完 pid 文件、内核尚未出现在 pgrep 的窗口内，并发 stop/reset 的零进程分支会删掉刚写的 pid 文件 → startTun 末尾 getPid() 为 null，把成功启动误报成「TUN 启动失败」。与上一条同族（探测与动作隔着一次查询），窗口亚秒级且旧 sudo 版同样存在（TTY 输密码即删），封死需要 start/stop 共享锁（跨进程锁在数据根目录、进程启动不在锁内），收益不抵复杂度
- **文件锁 stat→unlink 两步、不复核 inode**（已知理论缺口，记录不修）：两个触发形状——①等待者被冻结（合盖/换出）且系统时钟前跳，新鲜锁被当陈旧锁删；②持锁者已崩溃、锁确已陈旧时有两个等待者同走强夺，C 在自己的 stat 与 rm 之间被调度挂起，恢复后 rmSync 删掉 B 刚夺到的新鲜锁并自己 wx 成功，B/C 同时进临界区。token 所有权校验只防 finally 误删，防不住这个。两者都要求相邻两个同步 syscall 之间被调度挂起、属微秒级窗口；macOS 无用户态原子比较-删除原语（不自带 flock、Node 内置无建议锁），stat 之后的读后复核只能缩小窗口并制造虚假安全感，彻底关闭需更换锁原语（架构级），与「陈旧锁退回无锁竞态」同级接受，不为此加机制
- **sudo 密码窗口内 Ctrl+C 最长 60 秒无响应**（已知权衡）：两处提权（TUN 启动/残留清理）的 `spawnSync('sudo', …, {stdio:'inherit', timeout:60s})` 阻塞主线程，期间信号处理器无法执行——与 process-stop.ts 头注释「轮询必须 async 保障 SIGINT 可达」的预期在此窗口相悖。改异步 spawn 需自行处理 sudo 子进程回收与 TTY 归属，复杂度远超收益；超时上限 60s 有界，非死锁，记录不修
- **ui 命令的 getRunningState 查询无容错**：launchctl 瞬时失败会把 `ui` 挡死报「无法查询服务状态」。ui 是纯打开操作，失败重跑成本低且打开后不再依赖该查询，记录不修；若将来 ui 增加依赖运行态的分支，先补容错
- **上游 MetaCubeX/mihomo 的默认分支已变更为 main，且 main 是一个同名 Python 项目**（2026-09-30 起，pushedAt 与 description 均证实）；内核源码与发布仍在 Meta 分支，release 由 github-actions 持续发布（v1.19.31/v1.19.32）。**对 CLI 无影响**：版本查询与下载走 releases API（tag 固定，资产 URL 不变，D8 的来源钉死不受默认分支影响）；受影响的是任何不带 ref 的 contents/tree API 调用——拿到的是 Python 项目。上游源码核对（锁定清单对表）必须带 `?ref=Meta`（config-inbound-snapshot.spec 的引用已带）。若未来 release 停止更新或资产消失，再评估换源
- **start‖start 互替的观察窗误报**（全对枚举推演确认，记录不修）：A 已通过锁内 bootstrap、处于健康观察窗（1.2–3s、锁外）时，B（连敲的第二次 start/sub use/ow 重启）完成 bootout+bootstrap 把 A 的任务换成自己的——A 的轮询读到 unloaded → 报「内核未能进入运行状态」附日志尾部，而终态正确（B 的内核在跑）。触发要求 B 的全程落进 A 的观察窗（慢机器/连敲重启）；B 是 start 不 bump epoch，失败复读判据抓不到它。修复方向（备查）：健康轮询最终 healthy:false 分支复用 healthViaProcessProbe 兜底——B 的内核进程在则判 healthy（PID 是 B 的，用户视角代理确实起来了）；代价是健康判据再增一个消费语义，与「崩溃循环 isCrashed 先判」的现序兼容但复杂度上行，损害仅错误文案的排查方向，记录不修
- **matchesScope 的两个 fail-open 边界**（fuzz 差分定性，记录不加防御）：`match.name: ''`（空串 falsy 被跳过 → 无条件应用）与单独 `'*'`（头部 `*` 分支 slice 出空串 → endsWith 恒真）在函数层可达恒真语义；README 承诺的「空值报错、单独 `*` 报错」在文件加载期（normalizeMatch）拦截，真实文件路径到不了 matchesScope，仅手工构造 Entry 绕过加载期可达。收益不抵复杂度
- **锁定清单已于 2026-10-02 对照 v1.19.32 重新核对**：config.Inbound + RawConfig 入站/控制面键集与 v1.19.30 快照无差异（新增面孔 clash-for-android/etag-support/keep-alive 家族/ntp/global-* 均不开监听），快照版本标注刷新为 v1.19.32
- **原子写 fsync/fchmod 的文件系统边界**：非常规文件系统（如 NFS home）上 fsync 可返回 EINVAL，fchmod 是第二个硬失败 syscall（ FAT/exFAT 类权限位无意义）；两者都使原本 rename-only 能成功的写入整体失败——与 fsync 同一姿态接受，服务层不用感知——macOS APFS 实测无问题，未在其他文件系统实测。保证范围分层写在 atomicWriteFileSync docstring；崩溃遗留 `*.tmp` 的清扫在三道守卫与豁免判定**之后**执行（清扫是删除动作，不在被拒绝/豁免的命令上跑）
- **remove 时序修复无自动化回归测试**：写盘失败无法黑盒注入，postCommit 回滚删除刚写 yaml 的链路只用例锁住两侧不变式（终态守护 + 未命中不删文件），该修复本身靠代码审查
- **订阅侧 own `__proto__` 刻意不拦**（探针实测）：js-yaml 解析订阅顶层 `__proto__:` 得 own 键，经展示 walk（defineProperty 绕原型 setter）与 dump 均不炸，内核按未知键忽略；只有覆写**合并层**在操作符解析后拦截（覆盖 `__proto__!` 等形态），订阅侧透传是承诺行为
- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。热重载成功与查询失败回退已由 service-concurrency.spec 用 PATH 桩覆盖，install 恢复分支仍只能手工复现
- 控制器/入站家族锁定（external-controller-tls/-unix/-cors/-doh、tuic-server、ss-config/vmess-config、listeners/tunnels、tls 段、allow-lan 与鉴权家族）只回上游源码核对了键名与启动前提、用 buildConfig 实测了剥除，**没用真内核验证过额外监听真的开不出来**；unix socket 文件创建、TUIC/SS/Vmess server bind、`allow-lan: true` 下内核是否真的绑到全网卡等内核侧行为同理。**这不是待办**：主力开发机（Mac mini）按设计不装内核（见「平台实测备忘」末条），要验得换一台装了内核的机器，与 launchd 真实启停、TUN 提权同属「只能在别的机器上手工复现」那一类。剥除行为本身由 config.spec 全覆盖，内核侧只是第二道确认
- **锁定清单只有半自动兜底**：`config-inbound-snapshot.spec.ts` 冻结带上游版本号的 `config.Inbound` 字段集，差集必须逐项写明放行理由。**快照发现不了上游新增字段**，内核大版本升级时仍须人工刷新并对照上游源码；它只防止凭记忆重推整张清单，不能证明清单完整。核对证据是实际执行集与上游消费点，不是注释或测试名里曾出现过某个键
- **锁 `authentication` 的代价**：剥除来源盲，故用户也不能再用覆写给 Mixed 端口设代理鉴权。缓解是 `allow-lan` 已强制 false、Mixed 只监听回环，主要威胁面（局域网）已消失；残余是同机其他进程（含浏览器网页），与控制器默认无鉴权同一量级。控制器侧有 `controller_secret` 逃生口，Mixed 侧暂无——真有人需要再加 settings 键，不提前造开口
- `iptables`、`inbound-tfo`、`inbound-mptcp` 仍原样进运行配置：前者是 Linux 专用的系统集成开关、非监听，darwin 内核无该路径；后两者是 TFO/MPTCP 传输层 socket 选项，不开监听、不改绑定地址、不绕鉴权。config.spec 有用例锁住现状，决策改变时会明确失败而不是悄悄漂移
- 锁定告警只对覆写文件：覆写经操作符设置锁定键（如 `+secret`）已覆盖，但覆写文件内 `match:` 块之后、且文件解析失败被 warn 跳过时不会有告警（文件整体没生效，合理）
- 订阅名匹配**不引入通用匹配器**：只保留尾部 `*`（前缀）与头部 `*`（后缀）两种字面比对（`startsWith`/`endsWith`，无回溯结构），其余通配加载时报错，复杂匹配走 JS 脚本。通用 glob 转正则曾发生灾难性回溯；输入长度受限不能替代匹配复杂度论证
- 裸 `-` 在 argv 层按未知选项拦截、不豁免：本 CLI 没有「- 表示 stdin」的约定，静默吞掉它会让 `sub update -` 落成无参形态批量更新、`start -` 静默起默认代理；它也建不出 remove/use 能指定的订阅名（getNonFlagArg 把 `-` 开头 token 当选项跳过）。`-` 前缀 token（`-my-sub`）同由未知选项拦截——handler 层不再需要第二道名称守卫（positional-args.spec 锁口径）
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- startTun 的日志轮转在存在性校验之后；但 sudo 取消路径仍有窗口：轮转（rename 归档）到 pkill 实际执行之间用户取消的话，仍在运行的旧 TUN 内核会继续往归档文件写。rename 进不了 root 脚本（归档命名/清理在 TS 层），接受——下次成功启动自愈，logs 列表短暂缺当前日志
- TUN 方向的并发防线也有同族残余：startTun 复核点到 sudo 脚本内 pkill 实际执行之间隔着密码窗口，pkill 在 root 脚本内进不了锁。两道防线合起来覆盖了「B 在 A bump 之前/之后进锁」两种交错，但「B 恰在 A 复核后、pkill 前完成 bootstrap」的毫秒级窗口仍在——B 出锁前锁内 epoch 检查读的是 bump 后的值会放弃，故该窗口要求 B 的整个 enable+bootstrap 压进 A 复核到 pkill 之间，实际可达性极低，与 kickstart 锁外交错同级接受
- 锁内 launchctl 调用有持锁预算（最坏总时长 < `LOCK_STALE_MS`）：start 侧正常 enable+bootstrap 两次 6s、失败分支三次 9s，stop 侧 bootout+disable+复核共三次，单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s），别再往任何锁内加东西。锁内三环节（复核先于递增、递增在锁内、bootout 与 disable 同锁）谁也挪不出锁，缩减调用次数的路走不通，理由见 service.ts 该常量注释
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- 测试只依赖 macOS 自带命令（bash/launchctl/pgrep/pkill/lsof/gh）与 node 自身（bash 仅作桩脚本的 shebang）。doctor 的计时桩一度用 `python3` 取毫秒（`date` 不支持 `%3N`），是全仓唯一的外部依赖孤例，已改用 `process.execPath -e "Date.now()"`——跑测试的解释器必然在，路径也确定。新增测试桩需要取时间/做计算时照此办理，别再引第二个运行时
- `config` 是按当前缓存与设置重新推导的**配置预览**，不写盘、不重启、不做内核校验，因此可能展示内核会拒绝的配置。校验归 `doctor` 与 `start`；预览不代表运行中实例已应用，也不保证与会先自动更新订阅的下一次 `start` 完全相同
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路只能真机 sudo 验证：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受之；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- TUN 运行中 `sub use`/`ow` 按原模式重启、更新提示使用 `start tun`；真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未自动复测，仅经 runtime.spec 的桩内核路径验证决策
- 深审其余未修的低危项：`unhandledRejection`/`uncaughtException` 已统一口径但渲染函数本身不可注入测试；`NO_COLOR`/stderr 设色经 pty 手工验证、无自动化；clearProxyEnv 对企业 env 代理网络的影响已文档化（[D9](docs/decisions.md#d9-启动时只清除指向本机-mixed-端口的-env-代理)）但无提示机制。`npm_config_proxy` 等 npm 专属代理变量未清——npm 读 npmrc 不依赖该 env、gh/curl 不识别，不构成下载死锁，保持现状
- 曾记录但未修（判定接受或不可自动化）：`FORCE_COLOR` 不支持、`TERM=dumb` 仍出色；无 `--` 结束选项约定（当前无需要它的入口，订阅名已禁止 `-` 开头）；gh 资产名未拦前导 `-`（仅 GitHub API 被篡改时可达）；代理探测 curl 未加 `--proto =https`（只看 204 无机密）
- **reset 确认后重读仍有的残余窗口**（终审推演确认，记录接受）：危险分支（重读时 serviceActive=false）里，重读之后到删除 kernel/config 之间还隔着 cleanupAll 的 root 残留提权（sudo 密码窗最长 60s）；serviceActive=true 分支还隔 stop/uninstall 自身的锁等待（≤10s）与 bootout+waitUntilUnloaded（≤5s）。并发 install+start 整体落进这些窗口时其锁内判定放行（epoch 基线取自最近 bump 之后），删除后 KeepAlive 崩溃循环——与「stop 游离路径」同族同方向，但触发窗在有 root 残留时是秒到 60 秒级。不修的理由：删除前再读再 stop 会引入第二层窗口（uninstall 自身窗口内又可有并发，无穷回归），且触发需「root 残留内核存在 + 并发 install+start 恰在窗口完成 bootstrap」双重前置；若将来 reset 支持并发场景，优先考虑把删除段并入 serviceLock 临界区
- npm 不执行 uninstall 生命周期钩子（npm 11.19.0 三场景实测 + 官方文档注明未实现），preuninstall 设施已删除——卸载提醒只能靠 README 的顺序说明，别指望恢复钩子（README 卸载段已如实写）

## 已评估未采纳

- **全局 `--verbose`**：终端输出散在各模块，全局开关需要横切 argv 与输出层，收益不明。结构化诊断事件已经承担操作链留痕，不等于把各模块终端输出全部镜像成 verbose；排查已有 `doctor`、`logs`、`logs --diagnostic`、`status --json`
- **名为 help 的订阅 `use` 撞车**：频率极低、`sub use help` 可用、动 argv 拦截的风险大于收益
- **lsof 多 pid 取第一个**：误判方向是回退 kickstart，保守侧
- **stopService/uninstallService 的同形锁体不抽公共函数**：两处临界区各带不可拆的预算与顺序约束，抽取收益低
- **README 不逐一罗列裸 `-v`/`-h` 与 logs 的 `--follow`/`--open` 长形式**：与各命令帮助行同口径，短形式优先；完整选项以对应帮助为准
- **curl `-x` 与控制器 base URL 不并入 loopbackHttpUrl**：拼接语义不同（curl 代理地址 / 控制器 base URL），共用只会制造耦合
- **README 镜像 registry 帮助文案、不建 README↔registry 文本同步 spec**：README 命令表与 registry usage 是有意的双份形态（registry 是 CLI 帮助的唯一真相，README 是承诺文档）；跨格式模糊匹配比它防的漂移更脆。registry 内部口径一致由 help.spec 锁；复杂行为只在 README 一处详写，其他位置链接，不靠同步测试维持
- **「ports 配置非法」三处降级措辞不抽共享常量**：status（省略控制器后缀）、ui（整行换说法）、doctor（专项检查带修复指引）是三个展示语境的刻意分档，不冻结成同一文案

## 自动化测试边界

真实 sudo/TUN 会修改路由、需要密码并可能留下 root 属主文件，开发机和 CI 不自动执行

完整服务启停测试也不默认运行：enable/disable 会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 给每个临时 label 留永久记录，launchctl 无清除动词；只用 bootstrap/bootout 的一次性 label 可以临时验证有限的 launchd 行为，但不能覆盖 stop 的全部语义。要驱动服务层的 launchctl 路径时用 PATH 前置的桩 launchctl（service-concurrency.spec 的做法）：代码走真实路径、真实 launchd 一点不被碰，配 HOME/MIHOMO_CLI_DIR/一次性 label 三层隔离

进程与 reset 测试必须验证隔离前提：临时 MIHOMO_CLI_DIR 限定进程路径，独立 MIHOMO_CLI_DAEMON_LABEL 限定 plist/服务查询；涉及 plist 还要临时 HOME 与 PATH launchctl 桩，仅隔离数据目录不足以保护用户服务。清理 side effect 之前必须有硬 guard：killLeftovers 在任何 pkill 前验证 pattern 锚定 os.tmpdir 下的本次目录，runCli/runModule 在 spawn 前拒绝 env 覆盖隔离键；不能只在 beforeEach 之后的测试体里断言

doctor 的内核版本项与 npm 查询项取值依赖网络（GitHub 可达性、限流），用例只锁检查项存在，不写死 ok/warn/skip

子进程 + 本地桩 server 的用例必须**异步 spawn**：spawnSync 会阻塞父进程事件循环，桩 server 无法 accept、子进程 fetch 挂死（父子死锁，实测 30s 超时零请求到达桩）

## 平台实测备忘

- kickstart -k 可能阻塞超过 5s，当前使用独立的 60s 超时；bootout 未装载目标返回 3
- KeepAlive.PathState 只决定退出后是否重启，删除标志文件不会主动停止进程，不能用来替代 stop
- disabled 位独立于 plist 持久化，enable 也留记录；手工移除需 sudo plutil，keypath 的点须转义，磁盘修改要重启后才与 launchd 内存一致，不能做进 CLI 自动清理
- BSD ps command 列需 -ww，stat 用 -f%z；open 是异步桌面操作，返回后才可能失败，调用方保留手动路径
- 未装内核的开发机是正常环境，不能为了检查自动安装用户服务或提权；真机结论可能来自其他测试机器
