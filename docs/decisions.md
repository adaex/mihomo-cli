# 架构决策记录

每条记录一个跨模块、稳定、回答「仓为什么长这样」的决策：背景 → 决策 → 拒绝的替代方案 → 关键后果。只写现行状态与被否定的方案，不写演进过程——版本史留在 CHANGELOG 与 git

某条为什么不修、已知残余风险与实测结论记在 [CONCLUSIONS](../CONCLUSIONS.md)；各文档的归属见 [开发约定](development.md#文档归属)

新增决策在文末追加、编号不重排（代码注释按 D 编号引用）；决策被推翻时把条目改为「已废弃」并保留一句理由，不物理删除——否定过的方案会被人重新提议。

## D1 服务是用户级 LaunchAgent，不提供 root 安装

服务用用户域（`gui/<uid>`）LaunchAgent，正常 install/start/stop/uninstall 免密；清理 root 属主的 TUN 残留是独立的按需 sudo 路径。拒绝的替代：root LaunchDaemon（system 域）——每次启停都要输密码；选它是为绕开 macOS 本地网络隐私对局域网设备的限制，但 Apple DTS 明确豁免条件是「以 root 运行」而非「身为 daemon」——用户域 agent 只意味着走正常授权弹窗，且回环地址（如自建 ssh -D 出口）本就不属于「本地网络」，完全不触发该机制。

后果：CLI 全程以普通用户运行，TUN 的 root 需求由 CLI 内部按需 sudo（临时进程）；不做「读 SUDO_UID 回落用户域」的自动降级（sudo 下 HOME 是否保留取决于 sudoers，静默改域只会制造更难查的错位），index.ts 的 root 守卫直接拒绝。不识别也不清理早期版本遗留的 root LaunchDaemon（兼容窗口已结束）；极少数仍残留旧安装的机器（症状：代理停不掉、`/Library/LaunchDaemons/com.mihomo-cli.daemon.plist` 存在）手动清理——`sudo launchctl bootout system/com.mihomo-cli.daemon` 后 `sudo rm -f /Library/LaunchDaemons/com.mihomo-cli.daemon.plist`。

## D2 并发防线的判据是停止计数（epoch），不是 launchd 的 disable 位

两个终端并发 start/stop 时，「本次 start 执行期间是否有人 stop 过」launchd 自身给不出答案：disable 位是持久的、没有写入时间，「上次 stop 留下的」与「刚刚并发置的」完全同形。拒绝的替代判据：判「当前是否 disabled」，把持久位误判成并发位，stop 之后的每次 start 都静默不启动；判「disable 位前后快照比对」，在「上次也 stop 过」这个最常见前置下两边都是 true，并发 stop 隐形。

决策：CLI 自己维护单调递增的停止计数（service-stop-epoch 文件），stop 系列路径在「已确认不会自启且无内核在跑」之后递增，start 系列在锁内比对「计数是否变了」。递增点必须覆盖**没有 disable 可做**但同样得出停止结论的路径（stop 的提前返回、reset 的游离内核清理），否则防线只铺一条路径——「防线只铺一条路径」正是本仓反复栽的坑。

后果：计数文件必须与锁同放数据根目录（runtime/ 会被 rmrf，文件消失即读作 0，并发信息丢失）；读失败回退 0 是刻意的 fail-open（start 是用户显式意图，不该被辅助计数挡住）；锁内读-改-写由 service.lock 保护，锁外调用点允许丢递增（判据只问「变没变」，不问增量准不准）。

## D3 并发控制用同步文件锁 + 锁内调用预算，不用异步锁

withFileLock 要求临界区同步（持锁期间 await 等于按住锁等到强夺，等于没锁），而服务操作里有真实的异步等待（waitUntilUnloaded 最多 5s、订阅更新约 10s、kickstart 实测可超 5s）。决策：慢速阶段全部留在锁外，只有 launchctl 写操作（enable/bootstrap/bootout/disable + 幂等复读）进锁，且锁内调用次数 × 单次超时必须低于锁强夺阈值（10s）——故统一 3s（stop 侧三次 9s，start 侧失败分支三次 9s）。「把某次调用挪出锁」不是自由的：stop 侧的复核在递增前、递增在锁内、bootout 与 disable 同锁，start 侧的 enable 先于 bootstrap、幂等复读在锁内，都有不可拆的理由（见 service.ts 各函数头；预算常量注释在拆分后随迁 launchctl.ts 的 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS）。

后果：kickstart（60s 超时）刻意留锁外，其并发窗口由健康确认失败后复读 epoch 兜住；预算关系由 service-concurrency.spec 的常量断言锁死，新增锁内 launchctl 调用前先改测试。曾评估过异步锁/信号量方案，未采纳：临界区内容必须保持同步可推理，当前预算模型已被测试锁定，换锁机制等于重写整条防线。

## D4 并发基线在命令入口捕获为进程状态，消费点读同一份，不做参数透传

start/install/restart 都依赖「命令开始时的 epoch」做并发判定。危害窗口是「产生 wasRunning 的那次状态读取」到锁内判定之间：stop 在自己的锁内先递增、之后才 waitUntilUnloaded，存在「已递增而 launchctl print 仍报 running」的区间，函数内现取的基线必然已含对方的递增，并发隐形。故基线必须取在命令第一步——如今是 `main()` 在分发前调 `captureStopEpochBaseline()` 存入 stop-epoch 模块状态，此后锁内判定、热重载后复读、健康确认后复读都读同一份 `stopEpochBaseline()`，不再跨层透传参数（透传时代的教训：可选默认值让新调用方静默退化，5+ 消费点每次都要记得传）。未捕获时（测试直接调 service 函数）退化为当前值，即不判并发。

两个位置语义要记牢：① restartToApply（sub use / ow on|off 触发的重启）带着**原命令**的基线重入 start 链路，订阅下载期间的并发 stop 会被检出并取消重启——这是防线语义（终态与用户最后一条命令一致），基线若挪进 cmdStart 重入时刻即漏检，结构不变量由 service-concurrency.spec 的「并发基线是命令入口的进程状态」用例锁定；② TUN 分支 bump 之后**重捕获基线**（把「本命令造成的世界状态」设为新基线——自己的递增不算并发），启动前经 assertTunStartNotRaced 消费重捕获后的基线：sudo 密码窗内的并发 stop 会被检出并取消（终态与用户最后一条命令一致），TUN 之后若再走 Mixed 启动也用的是重捕获后的基线、不会自我取消。

## D5 入站端口与整个控制面是系统锁定项，订阅与覆写不可设置

远端订阅是不可信输入。锁定清单（constants.ts 的 LOCKED_CONFIG_KEYS）按「能否开监听」划分，判据是上游 `config.Inbound` 结构体字段全集 + `updateListeners()` 的逐个消费，不是按键名眼熟程度：redir/tproxy、external-controller 全家桶（-tls/-unix/-pipe/-cors/-routing-mark/-doh）、tuic-server 与 ss-config/vmess-config（三个完整入站代理服务端，自带监听与认证，不经过 genAddr，allow-lan 管不到它们）、listeners/tunnels（同判据的通用入站声明）、allow-lan/bind-address/authentication/skip-auth-prefixes/lan-*-ips（allow-lan 为真且 bind-address 为默认时 genAddr 返回全网卡地址，skip-auth-prefixes 又能把鉴权换成空实现——三行 YAML 即全网卡无鉴权开放代理）。顶层 tls 段同锁（-tls 控制器的证书来源）——它不是 `config.Inbound` 的结构体字段、不进快照表，但剥除与告警对它一视同仁：实际剥除执行集是 constants.ts 的 EFFECTIVELY_LOCKED_KEYS（快照表 + tls），YAML 告警扫描（lockedKeysReferencedBy）、剥除循环、脚本快照探针与 config-inbound-snapshot.spec 全部派生自这一份（早期四处各抄一份「表 + tls」，漏改静默）。刻意不锁的：iptables（Linux 专用）、inbound-tfo/inbound-mptcp（传输层 socket 选项，不开监听）、tun（由启动模式整段接管）。

后果：锁定项的恒定值由 buildConfig 的 systemConfig 写入，不放 BASE_CONFIG（后者语义是「用户没写时的默认」，会被剥除循环架空成死配置，两表无交集有测试锁死）；剥除对订阅与覆写一视同仁，但告警只对生效的覆写文件（订阅告警只会刷屏，用户无行动手段）；清单完整性由 config-inbound-snapshot.spec 的上游结构体快照 diff 兜底，内核大版本升级时人工刷新快照。

## D6 配置解析只走 YAML 解析器，不设独立 JSON 分支

YAML 1.2 是 JSON 的超集，标准 JSON 全部由 yaml.load 正常解析。曾有的 JSON.parse 回退唯一能走到的情况是重复键 JSON（YAML 明确报错，JSON.parse 静默取最后一个值）——那条回退把「坏数据」变成「静默接受」，方向正好错了：订阅出现重复键意味着上游生成有问题，取哪个值都是猜，必须报错。所有解析不可信来源的 yaml.load 统一带 maxAliases=200（防别名炸弹）——config.ts 的 loadYamlSafe 与 overwrite.ts 的内联调用共用 constants.ts 的同一 YAML_MAX_ALIASES 常量防漂移（内联是避免与 config 循环依赖的刻意形态）。

## D7 覆写加载有双路径：合并路径硬失败，诊断路径旁路

覆写文件坏了时，「启动失败」和「仪表盘被击穿」不能同时发生。合并路径（loadOverwriteFile）有 broken 即抛 CliError——warn+退出 0 会让启动成功但覆写没生效，语法错与语义错同级硬失败；诊断路径（listOverwriteFile，ow/status 用）把 broken 原样带出，红字渲染、status JSON 进 overwrite.errors。两条路径底层共用 readOverwriteFiles()（返回 { ok, broken }，不抛错），新增加载错误形态进 toBrokenFile，不在两条路径各写一份。

## D8 镜像只作用于产物下载，不作用于 GitHub API；镜像选择不持久化

API 若也走镜像，`browser_download_url` 就完全由镜像说了算，而内核产物随后 chmod 755 并会在 TUN 下以 root 运行——上游不提供 checksums，把来源钉死（assertTrustedAssetUrl 校验原始地址）是主要防线，不能让镜像自己指定下载地址。镜像选择不持久化，也不进入自动下载候选：只有用户显式传 `--mirror` 才启用，显式镜像或代理都只有一个下载候选，不在失败后擅自换道。每次默认调用仍按当前环境独立决策（gh/代理是否可用），避免换环境后沿用过期偏好

版本查询在代理可用时直接经代理；无代理且 gh 可用时先走 gh api 认证通道，失败再回退 curl 直连（`--noproxy '*'`，不读 env 代理）。curl 只替代原 Node fetch 的直连分支，gh 仍是独立的认证子进程通道（D9）。版本查询出网决策唯一出口是 kernel.ts 的 resolveReleaseQuery（cmdKernel 与 doctor 共用，与下载通道决策同源输入）；downloadKernel 只取产物、release 由调用方必传，不再有从下载通道反推查询方式的兜底路径

## D9 入口只清指向本机 Mixed 端口的 env 代理

无差别清除 http(s)_proxy 会让只能靠 env 代理出网的用户（企业网/其他工具）在 update/kernel 必败。唯一必须清除的是「代理恰好是本工具自己」的自指形态：下载经自己的端口，而重启会先停掉那个内核；内核没跑时则会连接死端口。判定按整条 URL，回环主机集合与端口比对；裸 localhost:7890 必须补协议重解析，http/https 的默认端口按 80/443 识别。本机端口在守卫前纯读 settings.json，异常回退默认 7890。

实现：入口调用 `proxy-env.ts` 的 `clearSelfProxyEnv` 清掉六个大小写代理键中的自指值，其他 env 保留；`recordClearedProxyEnv` 只登记原值，不自动恢复。进程内 fetch 在 `NODE_USE_ENV_PROXY=1` 时也读同一份 process.env，因此不能只在子进程 spawn 点做清理。

刻意的 per-spawn 例外有两处，共同前提都是该子进程全程不重启内核：

1. **内核下载的 gh 回退**：`buildGhDownloadEnv` 按通道注入 HTTPS_PROXY/https_proxy，并清掉 no_proxy/NO_PROXY，确保回退与首选 curl 走同一代理。内核产物自检通过后才原子换入，下载中途不重启内核。
2. **update/doctor 的 npm**：每次 spawn 前 TCP 探活自指端口，仍在监听才恢复用户原值；端口不活保持清除。不凭空注入代理，不改写 .npmrc，view 与 install 之间允许代理状态变化。

拒绝只在各出网子进程做 per-spawn 清理、完全不改 process.env 的方案：它会漏掉 `NODE_USE_ENV_PROXY=1` 时的进程内订阅 fetch，在本机代理未运行时重新引入下载失败。入口统一清理覆盖进程内与子进程两类消费方，npm 的恢复仍保持在每次 spawn 前。

## D10 settings 每次读盘，一致视图靠调用方显式传快照

readSettings() 无进程级缓存：CLI 是短进程，缓存省不了多少，却会让「同一操作内读到的设置不一致」这类 bug 无法被发现。需要一致视图时（如一次 start 内多处读端口/订阅），调用方在命令开头取一份快照显式传递——与 D4 的 epoch 快照同一姿态。

## D11 测试纪律（已迁出）

这是流程规则而非架构决策，已移入 [开发约定](development.md#隔离与反向验证)。编号保留，避免旧引用悬空。

## D12 覆写 DSL 裁边：声明式只留三个操作符，带条件的变换走 JS 脚本

判据：设施规模与真实使用面不匹配。保留 `key!`（替换）、`+key`（前插）、`key+`（追加）——纯数据、无逻辑。拒绝的替代：`~key` / `~?key`（按 name 合并数组元素与未命中两态）和 `<x>` 转义，语义复杂度超过真实使用面。这些旧形态与 `match` / `enabled` 的近失写法必须显式报错：内核会忽略未知顶层键，但文件内其他配置仍会按启用、无 match 的全局范围生效，不能把笔误当普通键静默放行。match 支持 `name` 与 `url-domain` 两个键；订阅名条件只保留 `name`，不再设 `subscription` 同义键。

复杂变换由 JS 脚本承担（`overwrite.js` / `overwrite.*.{js,mjs,cjs}`，默认导出函数）：**全信任模型**——脚本以用户身份运行、不沙箱不超时（同 `.zshrc`，README 明示别装来路不明的脚本），但**必须同步**（返回 Promise 报错：buildConfig 是同步管线，require(esm)（Node ≥22.12 即支持，本仓下界 24）同步加载、`await import` 会把整条合并链传染性 async 化，而纯转换没有要等网络的场景）。管线位置是安全关键：脚本执行 → YAML 合并 → 剥 LOCKED_CONFIG_KEYS → 系统配置注入（段序论证见 D13）——脚本设置的锁定键被剥除（安全边界对脚本输出一视同仁）但经前后深快照检出并告警（不静默，脚本作者会困惑「设置了怎么没生效」）；systemConfig 最后注入，脚本改不掉端口与控制面。脚本无 match/enabled 机制（作用域写在脚本里，想停用改扩展名），受 `ow` 全局开关与 selectActiveOverwriteFiles 闸门管理；返回值忽略，CLI 不判定脚本是否命中（D14）。加载失败/执行抛错与坏 YAML 同款双路径姿态（D7）。脚本的锁定键告警文案与 YAML 侧共用一份（renderLockedWarning），清单 LOCKED_CONFIG_KEYS 物理上住 constants.ts（overwrite.ts 要读它做快照、config.ts import overwrite.ts，反向会循环依赖）。

订阅名匹配只留尾部 `*`（前缀）与头部 `*`（后缀）两种字面比对（startsWith/endsWith，无回溯结构），其余通配报错。拒绝通用 glob 匹配器：它有灾难性回溯风险（实测 70 秒挂死，见 CONCLUSIONS），而真实使用面只有前缀区分一种；复杂匹配脚本里自己写。

## D13 覆写执行顺序：脚本在前、YAML 在后

管线为脚本执行 → YAML 声明式合并 → 剥 LOCKED_CONFIG_KEYS → 系统配置注入：心智模型是「程序化结构变换在前，声明式微调兜底」。理由：脚本承担整体结构重组（典型：重建整个 `proxy-groups` 数组），YAML 只做几条声明式注入（`+proxies`/`+rules`）；数组布局是「最后写入者决定」，若脚本最后执行，YAML 先前插的组会被重建抹到数组末尾，声明式微调就失去微调能力。拒绝的替代：YAML 先合并、脚本后处理。YAML 的 `+key` 前插永远落在脚本产出之后，不被重组吞掉。

后果：脚本看到的始终是订阅配置，读不到 YAML 注入项（ctx 只提供订阅信息）；需要 YAML 注入项的逻辑要并入脚本。顺序唯一真相是 `overwriteSortKey`：段序（脚本 0 / YAML 1）→ 主文件优先 → 文件名码点序；`ow` 列表与合并共用同一排序，列表即执行序。

安全边界不随段序移动：剥 LOCKED_CONFIG_KEYS 在**全部**覆写之后、systemConfig 最后注入，两类覆写都改不掉入站与控制面；脚本锁定键检测是执行前后深快照（before 是订阅配置，本就含机场下发的端口键），不依赖 YAML 先合并；YAML 侧锁定键检测作用于最终合并配置，与文件顺序无关。

## D14 CLI 不判定脚本是否命中，status 不调用变换函数

决策：脚本返回值忽略；status 把启用中的脚本一律列入覆写清单，不调用变换函数。这里的「生效」与 `overwrite.applied` 只表示「按总开关、文件开关和 YAML match 选中，启用脚本全部列入」，不证明脚本适用于当前订阅或实际修改了配置。

拒绝的替代：脚本用 `return true` 报告命中、让 status 区分「生效/不适用」——需要额外的类型、applyOverwrite 的附加返回值与独立旁路，代价是 `status` 为得到一行展示信息而额外调用用户变换函数。判据与 D12 相同：设施规模与真实使用面不匹配。也拒绝「保留判定但缓存结果」：缓存需要失效协议，而展示收益不抵这套状态。

边界必须写全：`ow` / `status` 加载模块时仍会执行顶层代码，`doctor` 构建配置时仍会调用变换函数。本条只取消 status 为命中判定额外执行变换函数，不宣称诊断面不执行任何用户代码。

`status --json` 只提供上述选中口径的 `applied`，不另设 `overwrite.files`，避免两个字段并存时让消费者选错。

## D15 代理接入按应用配置，CLI 不管理 macOS 全局代理

Mixed 的产品边界是提供回环 HTTP + SOCKS5 端口，不是接管系统网络设置。用户的主路径是在具体浏览器或需要代理的应用中按需配置 `127.0.0.1:<mixed-port>`，不依赖全局 Mac 代理

决策：CLI 不读取、设置、切换或清除 macOS 系统代理（不调用 `networksetup`/`scutil`），不提供全局 `proxy on/off`，快速开始与启动提示也不把全局代理配置作为推荐步骤。`start` 成功后只打印一行静态提示（Mixed 地址与按应用配置的说明）。`proxy-env.ts` 只处理进程 env，用于避免自指死锁（D9），不能扩展成读写系统设置

拒绝的替代：`start` 时用 `scutil --proxy` 检测系统代理是否指向本机、按三档给提示——检测的是「系统代理」，而用户的主路径本来就不走系统代理，提示对多数人是噪声，且引入对系统命令输出格式的解析依赖。

后果：`start` 成功只表示内核与端口可用，不表示所有应用流量已走代理；用户文档必须在 Mixed 主路径说明按应用配置。TUN 是用户显式选择的另一种接管系统流量的模式，不是 CLI 自动修改全局代理的替代后门

## D16 CLI 诊断事件日志（已废弃）

曾在 `logs/diagnostic.jsonl` 独立记录 CLI 历史操作链（白名单元数据、一次调用共享 operation id）。它提供的是 `doctor` / `status` 当前状态之外的排障维度，并非信息重复；本轮选择移除，是为了不再长期维护独立写入、轮转、退出钩子与字段白名单，而不是因为 best-effort 日志必须承担审计语义。

当前排障以实时状态、配置检查和内核日志为主。若将来重提历史操作链，先给出这些入口无法回答的具体问题，再评估独立设施的收益。旧安装留下的 `diagnostic*.jsonl` 不再轮转，可经 `mihomo-cli dir open logs` 手动删除。