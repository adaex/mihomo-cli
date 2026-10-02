# 架构决策记录

每条记录一个稳定决策：背景 → 决策 → 拒绝的替代方案 → 关键后果。

代码注释只保留结论与本不变的判据，历史细节与两版教训在这里；版本修复流水在 CHANGELOG.md；审查结论与边界在 CODE_REVIEW.md。新增决策在文末追加，不重写旧条目；决策被推翻时把条目改为「已废弃」并指向取代它的条目，不物理删除——否定过的方案会被人重新提议。

## D1 服务是用户级 LaunchAgent，不提供 root 安装

v3.0–v4.0 用 root LaunchDaemon（system 域），每次启停都要输密码。改用用户域（`gui/<uid>`）后 install/start/stop/uninstall 全程免密。旧实现选 root 是为绕开 macOS 本地网络隐私对局域网设备的限制，但 Apple DTS 明确豁免条件是「以 root 运行」而非「身为 daemon」——用户域 agent 只意味着走正常授权弹窗，且回环地址（如自建 ssh -D 出口）本就不属于「本地网络」，完全不触发该机制。

后果：CLI 全程以普通用户运行，TUN 的 root 需求由 CLI 内部按需 sudo（临时进程）；仍保留遗留 root LaunchDaemon 的识别与清理（它有 KeepAlive 会抢端口，不认就是幽灵）；不做「读 SUDO_UID 回落用户域」的自动降级（sudo 下 HOME 是否保留取决于 sudoers，静默改域只会制造更难查的错位），index.ts 的 root 守卫直接拒绝。

## D2 并发防线的判据是停止计数（epoch），不是 launchd 的 disable 位

两个终端并发 start/stop 时，「本次 start 执行期间是否有人 stop 过」launchd 自身给不出答案：disable 位是持久的、没有写入时间，「上次 stop 留下的」与「刚刚并发置的」完全同形。判据演进的两版教训：v4.7.5 判「当前是否 disabled」，把持久位误判成并发位，stop 之后的每次 start 都静默不启动；v4.7.6 判「disable 位前后快照比对」，在「上次也 stop 过」这个最常见前置下两边都是 true，并发 stop 隐形。

决策：CLI 自己维护单调递增的停止计数（service-stop-epoch 文件），stop 系列路径在「已确认不会自启且无内核在跑」之后递增，start 系列在锁内比对「计数是否变了」。递增点必须覆盖**没有 disable 可做**但同样得出停止结论的路径（stop 的提前返回、reset 的游离内核清理），否则防线只铺一条路径——「防线只铺一条路径」正是本仓反复栽的坑。

后果：计数文件必须与锁同放数据根目录（runtime/ 会被 rmrf，文件消失即读作 0，并发信息丢失）；读失败回退 0 是刻意的 fail-open（start 是用户显式意图，不该被辅助计数挡住）；锁内读-改-写由 service.lock 保护，锁外调用点允许丢递增（判据只问「变没变」，不问增量准不准）。

## D3 并发控制用同步文件锁 + 锁内调用预算，不用异步锁

withFileLock 要求临界区同步（持锁期间 await 等于按住锁等到强夺，等于没锁），而服务操作里有真实的异步等待（waitUntilUnloaded 最多 5s、订阅更新约 10s、kickstart 实测可超 5s）。决策：慢速阶段全部留在锁外，只有 launchctl 写操作（enable/bootstrap/bootout/disable + 幂等复读）进锁，且锁内调用次数 × 单次超时必须低于锁强夺阈值（10s）——故统一 3s（stop 侧三次 9s，start 侧失败分支三次 9s）。「把某次调用挪出锁」不是自由的：stop 侧的复核在递增前、递增在锁内、bootout 与 disable 同锁，start 侧的 enable 先于 bootstrap、幂等复读在锁内，都有不可拆的理由（见 service.ts 各函数头；预算常量注释在拆分后随迁 launchctl.ts 的 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS）。

后果：kickstart（60s 超时）刻意留锁外，其并发窗口由健康确认失败后复读 epoch 兜住；预算关系由 service-concurrency.spec 的常量断言锁死，新增锁内 launchctl 调用前先改测试。曾评估过异步锁/信号量方案，未采纳：临界区内容必须保持同步可推理，当前预算模型已被测试锁定，换锁机制等于重写整条防线。

## D4 并发基线在命令入口捕获为进程状态，消费点读同一份，不做参数透传

start/install/restart 都依赖「命令开始时的 epoch」做并发判定。危害窗口是「产生 wasRunning 的那次状态读取」到锁内判定之间：stop 在自己的锁内先递增、之后才 waitUntilUnloaded，存在「已递增而 launchctl print 仍报 running」的区间，函数内现取的基线必然已含对方的递增，并发隐形。故基线必须取在命令第一步——如今是 `main()` 在分发前调 `captureStopEpochBaseline()` 存入 service 模块状态，此后锁内判定、热重载后复读、健康确认后复读都读同一份 `stopEpochBaseline()`，不再跨层透传参数（透传时代的教训：可选默认值让新调用方静默退化，5+ 消费点每次都要记得传）。未捕获时（测试直接调 service 函数）退化为当前值，即不判并发。

两个位置语义要记牢：① restartToApply（sub use / ow on|off 触发的重启）带着**原命令**的基线重入 start 链路，订阅下载期间的并发 stop 会被检出并取消重启——这是防线语义（终态与用户最后一条命令一致），基线若挪进 cmdStart 重入时刻即漏检，结构不变量由 service-concurrency.spec 的「并发基线是命令入口的进程状态」用例锁定；② TUN 分支 bump 之后**重捕获基线**（把「本命令造成的世界状态」设为新基线——自己的递增不算并发），启动前经 assertTunStartNotRaced 消费重捕获后的基线：sudo 密码窗内的并发 stop 会被检出并取消（终态与用户最后一条命令一致），TUN 之后若再走 Mixed 启动也用的是重捕获后的基线、不会自我取消。

## D5 入站端口与整个控制面是系统锁定项，订阅与覆写不可设置

远端订阅是不可信输入。锁定清单（constants.ts 的 LOCKED_CONFIG_KEYS）按「能否开监听」划分，判据是上游 `config.Inbound` 结构体字段全集 + `updateListeners()` 的逐个消费，不是按键名眼熟程度：redir/tproxy、external-controller 全家桶（-tls/-unix/-pipe/-cors/-routing-mark/-doh）、tuic-server 与 ss-config/vmess-config（三个完整入站代理服务端，自带监听与认证，不经过 genAddr，allow-lan 管不到它们）、listeners/tunnels（同判据的通用入站声明）、allow-lan/bind-address/authentication/skip-auth-prefixes/lan-*-ips（allow-lan 为真且 bind-address 为默认时 genAddr 返回全网卡地址，skip-auth-prefixes 又能把鉴权换成空实现——三行 YAML 即全网卡无鉴权开放代理）。顶层 tls 段同锁（-tls 控制器的证书来源）——物理不在表内、由 config.ts 单独剥除，效果等同（config-inbound-snapshot.spec 的 EFFECTIVELY_STRIPPED 文档化此旁路，认效果不认数组成员资格）。刻意不锁的：iptables（Linux 专用）、inbound-tfo/inbound-mptcp（传输层 socket 选项，不开监听）、tun（由启动模式整段接管）。

后果：锁定项的恒定值由 buildConfig 的 systemConfig 写入，不放 BASE_CONFIG（后者语义是「用户没写时的默认」，会被剥除循环架空成死配置，两表无交集有测试锁死）；剥除对订阅与覆写一视同仁，但告警只对生效的覆写文件（订阅告警只会刷屏，用户无行动手段）；清单完整性由 config-inbound-snapshot.spec 的上游结构体快照 diff 兜底，内核大版本升级时人工刷新快照。

## D6 配置解析只走 YAML 解析器，不设独立 JSON 分支

YAML 1.2 是 JSON 的超集，标准 JSON 全部由 yaml.load 正常解析。曾有的 JSON.parse 回退唯一能走到的情况是重复键 JSON（YAML 明确报错，JSON.parse 静默取最后一个值）——那条回退把「坏数据」变成「静默接受」，方向正好错了：订阅出现重复键意味着上游生成有问题，取哪个值都是猜，必须报错。所有解析不可信来源的 yaml.load 统一带 maxAliases=200（防别名炸弹）——config.ts 的 loadYamlSafe 与 overwrite.ts 的内联调用共用 constants.ts 的同一 YAML_MAX_ALIASES 常量防漂移（内联是避免与 config 循环依赖的刻意形态）。

## D7 覆写加载有双路径：合并路径硬失败，诊断路径旁路

覆写文件坏了时，「启动失败」和「仪表盘被击穿」不能同时发生。合并路径（loadOverwriteFile）有 broken 即抛 CliError——warn+退出 0 会让启动成功但覆写没生效，语法错与语义错同级硬失败；诊断路径（listOverwriteFile，ow/status 用）把 broken 原样带出，红字渲染、status JSON 进 overwrite.errors。两条路径底层共用 readOverwriteFiles()（返回 { ok, broken }，不抛错），新增加载错误形态进 toBrokenFile，不在两条路径各写一份。

## D8 镜像只作用于产物下载，不作用于 GitHub API；镜像选择不持久化

API 若也走镜像，`browser_download_url` 就完全由镜像说了算，而内核产物随后 chmod 755 并以 root 运行（TUN/系统级服务）——上游不提供 checksums，把来源钉死（assertTrustedAssetUrl 校验原始地址）是主要防线，不能让镜像自己指定下载地址。镜像选择不持久化：每次调用按当前环境独立决策（gh/代理是否可用），记住偏好在换环境后会用到错误的镜像。版本查询在代理可用时直接经代理（出网路径已定，先试 gh 直连再回退会把「直连被墙」的等待叠加在可用代理前面）；无代理可用才走 gh api 认证通道（免 60 次/时未认证限流）。

## D9 启动时只清除指向本机 Mixed 端口的 env 代理

无差别清除 http(s)_proxy 会让只能靠 env 代理出网的用户（企业网/其他工具）在 update/kernel 必败，且报错与代理无关。唯一必须清除的是「代理恰好是本工具自己」的死锁：下载经自己的端口，而重启会先停掉那个内核。判定按整条 URL（不按逗号拆分），回环主机集合（127.0.0.1/localhost/::1/0.0.0.0/::——后两者 connect 会路由到本机监听器）与端口比对；裸 localhost:7890 必须补协议重解析（new URL 会把它当 scheme、hostname 为空而漏判）。守卫前用无副作用的只读方式取端口，异常回退默认 7890。

刻意的并存例外有两处，共同前提都是「该子进程全程不重启内核」，且一律 per-spawn 注入、不写回 process.env：

1. **内核下载的 gh 回退**：gh（Go）没有命令行代理选项。通道决策把本机代理地址挂在 gh 候选上（与首选 curl 通道同一出网路径，与用户是否配过 env 无关），下载时注入 HTTPS_PROXY/https_proxy。v26.10.98 初版只在注释里假设「gh 继承同一代理」而未注入，被入口清除打掉后 gh 实际直连，是这条并存关系没写清导致的缺陷。
2. **update/doctor 的 npm**：npm 是用户环境的工具，通道决策不管它，故只**忠实恢复用户自己原本配过的形态**——清除时登记原值（recordClearedProxyEnv），npm spawn 前 TCP 探活被指端口：在监听（内核在跑）才注回全部被清键；端口不活（env 残留/内核已停）保持清除，死锁防护照旧。不凭空注入：没用 env 代理习惯的用户（如 .npmrc 配镜像源）路径不变；.npmrc 显式 proxy 配置优先级高于 env，也不会被覆盖。探活每次 spawn 独立（view 与 install 之间隔着用户确认，代理状态允许变）。

## D10 settings 每次读盘，一致视图靠调用方显式传快照

readSettings() 无进程级缓存：CLI 是短进程，缓存省不了多少，却会让「同一操作内读到的设置不一致」这类 bug 无法被发现。需要一致视图时（如一次 start 内多处读端口/订阅），调用方在命令开头取一份快照显式传递——与 D4 的 epoch 快照同一姿态。

## D11 测试纪律：反向验证与隔离断言

修完必做反向验证：把修复还原，确认对应用例真的转红。预测「理应会红」不能代替实跑——预测落空处往往正是认知与实现的偏差点，比预测对更值钱；发现后补不变量用例挡在结构层，别只改当前这一处。进程匹配类测试必须断言隔离前提（临时 MIHOMO_CLI_DIR，涉及服务时再加一次性 MIHOMO_CLI_DAEMON_LABEL）；真实 sudo/TUN 与永久污染 launchd disabled 表的用例不自动执行，理由见 CODE_REVIEW「自动化测试边界」。

## D12 覆写 DSL 裁边：声明式只留三个操作符，带条件的变换走 JS 脚本

判据与 v4.13.0 删补全子系统同一条：设施规模与真实使用面不匹配。`~key`/`~?key`（按 name 合并数组元素 + 未命中追加/跳过两态）是唯一「一句话说不清」的操作符，历史上贡献了 v4.8.1 的残缺分组事故；`<x>` 尖括号转义与嵌套形似告警服务的是不存在的键名形态（mihomo 顶层键无 `+`/`~`/`!`/尖括号），零使用记录。保留 `key!`（替换）、`+key`（前插）、`key+`（追加）——纯数据、无逻辑；match 的 `subscription` 同义键一并收掉（同 D11「一套判据」的取向）。

复杂变换由 JS 脚本承担（`overwrite.js` / `overwrite.*.{js,mjs,cjs}`，默认导出函数）：**全信任模型**——脚本以用户身份运行、不沙箱不超时（同 `.zshrc`，README 明示别装来路不明的脚本），但**必须同步**（返回 Promise 报错：buildConfig 是同步管线，require(esm)（Node ≥22.12，本仓下界 22.22.1）同步加载、`await import` 会把整条合并链传染性 async 化，而纯转换没有要等网络的场景）。管线位置是安全关键：脚本执行 → YAML 合并 → 剥 LOCKED_CONFIG_KEYS → 系统配置注入（段序的翻转与论证见 D13）——脚本设置的锁定键被剥除（安全边界对脚本输出一视同仁）但经前后浅快照检出并告警（不静默，脚本作者会困惑「设置了怎么没生效」）；systemConfig 最后注入，脚本改不掉端口与控制面。脚本无 match/enabled 机制（作用域写在脚本里，想停用改扩展名；命中与否由 `return true` 报告，见 D13 尾段），受 `ow` 全局开关与 selectActiveOverwriteFiles 闸门管理；加载失败/执行抛错与坏 YAML 同款双路径姿态（D7）。脚本的锁定键告警文案与 YAML 侧共用一份（renderLockedWarning），清单 LOCKED_CONFIG_KEYS 物理上住 constants.ts（overwrite.ts 要读它做快照、config.ts import overwrite.ts，反向会循环依赖）。

订阅名匹配同轮裁边：只留尾部 `*`（前缀）与头部 `*`（后缀）两种字面比对（startsWith/endsWith，无回溯结构），其余通配报错——通用 glob 匹配器曾有灾难性回溯事故（70 秒挂死，见 CODE_REVIEW），而真实使用面只有前缀区分一种；复杂匹配脚本里自己写。

## D13 覆写执行顺序翻转：脚本在前、YAML 在后

D12 原定「YAML 全部合并 → 脚本执行」（声明式基底，程序化后处理）。真实形态是脚本承担整体结构重组（典型：重建整个 `proxy-groups` 数组），YAML 只做几条声明式注入（`+proxies`/`+rules`）；脚本最后执行并整体重建数组时，YAML 先前插的组被抹到数组末尾——数组布局是「最后写入者决定」，声明式微调失去微调能力。翻转后管线为脚本执行 → YAML 声明式合并 → 剥 LOCKED_CONFIG_KEYS → 系统配置注入：心智模型改为「程序化结构变换在前，声明式微调兜底」，YAML 的 `+key` 前插永远落在脚本产出之后、不被重组吞掉。

Breaking 面：脚本看到的始终是订阅配置，读不到 YAML 注入项（ctx 只提供订阅信息）；依赖旧顺序的写法需把那段逻辑并入脚本。顺序唯一真相仍是 `overwriteSortKey`：段序（脚本 0 / YAML 1）→ 主文件优先 → 文件名码点序；`ow` 列表与合并共用同一排序，列表即执行序。

安全边界不随段序移动：剥 LOCKED_CONFIG_KEYS 在**全部**覆写之后、systemConfig 最后注入，两类覆写都改不掉入站与控制面；脚本锁定键检测是执行前后浅快照（before 是订阅配置，本就含机场下发的端口键），不依赖 YAML 先合并；YAML 侧锁定键检测作用于最终合并配置，与文件顺序无关。

脚本的命中报告走返回值（`return true`）：脚本没有 match 声明，`selectActiveOverwriteFiles` 恒放行，status 的「生效/不适用」此前对脚本永远报生效——作用域不中的脚本混在生效清单里，与「match 不命中的 YAML」同一种误读。约定刻意最简：判据过了在函数末尾 `return true`，其余（提前退出、无返回值）一律未命中；严格 `=== true`，返回 config 等对象不算（防「顺手 return」被误读）。判定不参与合并闸门（selectActiveOverwriteFiles 不看它），只供展示：buildConfig 透传 `scriptMatches`，config 的提示段对未命中脚本给一行事实性提示（不断言「没改配置」——漏写 return true 的脚本可能已改了配置，提示只报告约定信号）。status 的判定走**独立旁路** judgeScriptMatches 而非 buildConfig：后者吃 loadOverwriteFile 的硬失败门，一个坏 YAML 就把全部脚本判定打回「未判定＝生效」——恰是判定要消灭的误读；旁路复用 listOverwriteFile 同一次读目录的 entries（typo 警告与 YAML 解析不跑两遍）、无脚本的目录直接跳过，坏订阅按未判定降级（诊断面不崩，D7 同款姿态）。
