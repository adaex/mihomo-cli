最近审查：2026-10-02，第十三轮（定向 fuzz + 覆盖盲区盘点 + 发布前对账），修 1 项 + 补 11 条用例：maskUrl 畸形输入降级路径的「前15...后10」会把 token 尾段带进错误消息（fuzz 抓出；合法 URL 200 万级组合长值/userinfo 100% 被遮、parseIntArg 20 万组不变量全过）；补五个盲区——TUN 启动脚本观察窗（180/540ms 漏报与僵尸误判事故的护栏，导出 buildTunLaunchScript 子进程 bash 执行）、launchctl 112/125 消费点、cmdUninstall 幂等三形态、clearProxyEnv 接线（自指清除/他端口保留/损坏 settings）、logs 0 退出码透传；盘点结论：无死代码（getPorts 等逐个 grep 核实消费者），若干内部使用零外部消费的 export 关键字冗余不收（风险大于收益）。发布前对账全绿：npm audit 0 漏洞、pack 产物无路径泄漏、dist 与 tsx 21 命令逐字等价、git 全史扫描干净、CHANGELOG 对账覆盖。全量 typecheck / 913 测试 / Biome / build 全绿。

前一轮审查：2026-10-02，第十二轮（decisions.md D1–D13 与实现现状逐条对照 + 供应链/产物/发布前对账），修 5 处文档滞后、零代码问题：**D4 ② 实质过时**（「TUN 不消费基线」已被 TUN 并发复核修复推翻——现为 bump 后重捕获、assertTunStartNotRaced 消费重捕获基线，git 佐证 decisions 未随 ab4525f 同步）；D5「config.ts 的 LOCKED_CONFIG_KEYS」实住 constants.ts（与 D12 自相矛盾，以 D12 为准）；D3 函数头指向补 launchctl.ts 常量注释；D6「统一入口 loadYamlSafe」如实化为「两处入口共用同一常量」（overwrite.ts 从未用过 loadYamlSafe，系初始措辞不精确非回归）；D5 补 tls 表外单独剥除半句（快照 spec 已文档化的刻意旁路）。**核心结论：四轮大修没有违反任何决策的精神**——D2 递增点全覆盖（本轮未新增「得出停止结论却不递增」路径）、D3 锁内预算完好（热重载 timer/reset 重读/withDisabled 全在锁外）、D9 两个例外、D13 段序全部逐行核实。另：npm audit 0 漏洞（过期均 patch 级，dependabot 覆盖）；npm pack 产物 5 文件无开发机路径泄漏；CHANGELOG Unreleased 31 条与 16 个 commit 逐条对账全覆盖（wt-done 发布前纪律）；doctor 0.62s 与基线同量级；tsconfig strict 全开。

前一轮审查：2026-10-02，第十一轮（README 全文承诺面对照 + 新增测试假阳性抽验 + 真实链路实测），修 9 项：README 五处不同步（ow on/off 重启透传未写、kernel 参考表缺 --proxy、sub add 用法行 <url> 应为 [url]（剪贴板回退，改实现侧）、「内存占用」限定 TUN 模式、启动失败示例缺末行）；http.spec 两条恒真/错位断言（「超大错误体→data undefined」的纯垃圾 fixture 对截断/不截断全绿，换合法 JSON 判别 fixture 并反向验证；e2e 用例如实改名锁「错误路径超限读被吞不升级」）；kernel.spec 白名单用例补「curl 零调用」排序断言（此前只锁替换前拒、不锁先于下载）；fchmod 落位与 restartService label 校验两个修复补零覆盖用例（子进程 umask 077 断言 0644/0600、非法 label 入口断言），均反向验证转红。真实链路实测通过：内核下载全链（真网络 19.8MB → 真内核自检 → 版本对账 → 原子替换）、JS 脚本重建 proxy-groups、脚本改锁定键被剥除且告警、YAML +rules 前插落在脚本产出后（D13 顺序）。核对无误：第十轮 4 项修复本身全部成立（fchmod 位置与 fd 生命周期、restart 断言顺序与 install/start 同序、re-export 与 a9ca602 逐符号对齐含裸 re-export 形式）、其余抽验的 898 用例断言逻辑（waitServiceHealthy 的 ISOLATION 非恒过、reset 桩 print 三次调用时序与实现对得上、doctor 时间线区间交集等）。全量 typecheck / 900 测试 / Biome / build 全绿。

前一轮审查：2026-10-02，第十轮终审（独立 agent 审第九轮 diff + 主仓冒烟），修 5 项：①第九轮声称收窄 7 个 re-export 实际只删了 2 个——格式化把其余 5 个留在块里，三条声明失实（本文件「文档与流程复盘」写过「『已核对』的记述会被后人当成已核对」，正是该形态），终审以基线比对抓出并补齐；②atomicWriteFileSync 改 fchmod 落定权限（open(2) 的 mode 受 umask 掩蔽，fchmod 不受），installService 事后 chmod 删除；③restartService 补 assertServiceLabelSafe（kickstart 路径既存缺口）；④paths.ts 两处 copyFileSync 旧措辞残留；⑤冒烟实测全命令面/错误路径/空串口径/脱敏出口/dist 产物全部通过。核对无误项：parseIntArg 逐形态推演（含 start -u -s 与 a9ca602 一致、顺带修复第八轮收集式引入的 -n -n 误诊回归）、mirrorIneffective gating、runtime 挪位、hot-reload 注释、README 通道段一致性。全量 typecheck / 898 测试 / Biome / build 全绿。

# 代码审查：现行结论与边界

规则见 CLAUDE.md，决策论证见 docs/decisions.md，版本历史见 CHANGELOG。本文只保留**现行有效**的三样东西：实测结论、未覆盖风险、流程教训。历轮审查的逐项验证流水不在此堆放——看当轮 CHANGELOG 条目与 git 历史；每轮审查收尾时，把仍然成立的结论合并进对应节，过时的删掉。改相关代码时同步更新对应节。

前一轮审查：2026-10-02，第九轮复审（自查 + code-review 过第八轮合入批次 a9ca602..HEAD），修 10 项：reset 确认后重读与 legacy sudo 窗口的顺序（重读挪清理后）；installService 原子写丢 chmod 的 umask 掩蔽；`logs ""` 空串口径同族漏网（getNonFlagArg 空串 vs null）；parseIntArg 漏值形态误报重复（重写为跳值式，先诊断值再诊断重复）；mirror 前缀未作用时的矛盾提示；runtime 注释错位与五处过时注释；re-export 面收窄（实收 2 个、余 5 个由第十轮终审补齐）。拆分验证结论：符号级比对 58 个符号代码体零变化（除两处有意修改），行级比对仅丢一行分节注释（已补）。中途一次全量 813+3 失败为 node --test 并发下 spec 加载偶发（测试总数掉落即加载被吞），重跑连续三次 898 全绿。全量验证 typecheck / 898 测试 / Biome（101 文件，仅 1 既存 noProto warning）/ build 全绿。

前一轮审查：2026-10-02，第八轮全仓复审（四路模块深审 + 主仓抽查验证关键发现），共 20 项修复 + 6 块闸门补测 + service.ts 拆分，逐项见 CHANGELOG Unreleased 节。要点：sub 列表 web_page_url 与降级守卫错误消息两处脱敏边角（其余 URL 出口均已脱敏、机制齐全但出口枚举有漏）；空覆写文档在 js-yaml 5 下抛异常而非返回 null（注释按 js-yaml 4 写的，升级后行为失实）；reset 确认窗口 TOCTOU（确认后重读服务状态）；带值选项重复静默取先者（与 kernel 口径相悖）；waitServiceHealthy 用例违反 D11 隔离纪律（改子进程 + MIHOMO_CLI_DIR）；补齐六块安全关键闸门的零覆盖（downloadKernel 完整性闸门、assertTrustedAssetUrl、assertLooksLikeSubscription 写闸、http 大小上限、waitUntilUnloaded 耗尽与 disable 位复核、log 命令行为），全部做过反向验证；service.ts 拆四节（launchctl/stop-epoch/legacy-cleanup/hot-reload），re-export 保持导出清单、全仓 import 不变。记录不修：process-stop 的 stop() warn 分档与 classifyResidueCleanup 语义等价但未合并（合并需动行为语义，拆分后 classifyResidueCleanup 已是唯一判据出口，漂移面已缩小，收益不抵风险）；stopService/uninstallService 的同形锁体未抽（两处各四行、注释各带不可拆理由，抽取收益低）。全量验证 typecheck / 893 测试 / Biome（96 文件，仅 1 个既存 noProto warning）/ build 全绿。

前一轮审查：2026-10-02，五轮全仓复审（设计/逻辑/产品 + start/stop/TUN 成对并发枚举 + 7 目标 150K 次 fuzz + 手工改坏缓存的兼容测试），随后合入同日远端 v26.10.98（内核链路那轮见下段），合入后又整体复查两轮。共 19 项修复 + 1 项 breaking：命令入口收敛为 `mihomo-cli`/`mh`（旧 `mihomo` 与内核二进制同名，两个包管理器全局 bin 互相覆盖），SECURITY/CLAUDE/README/help 与全部提示文案随之统一；TUN 启动前并发复核（sudo 密码窗内并发 stop 的终态反转，epoch 基线 + 服务装载态双判据，TUN 分支自己 bump 后重捕获基线防自触发）；终端消毒补剥 `\r`（回车回行首可把 `✗` 伪造成 `✓`）；凭据脱敏补 hysteria(1.x) `auth`、hysteria2 `obfs-password` 与 realm-opts `token`；`parseConfigContent` 坏订阅改 CliError 不渲染堆栈；`formatTraffic` 非有限值不再漏 `NaN%`；`waitServiceHealthy` 查询失败按「本轮未知」轮询、宽限期全程失败与观察窗同走进程探测兜底；遗留 root 清理 `rm` plist 后复核存在性（失败不再假报成功）；argv 负形订阅名引导、settings 脱敏键去重加结构断言、update 版本决策抽纯函数并补测、help 别名行补齐、README 补 Node >= 22.22.1 前置、入站锁定清单对照 v1.19.32 零差异。记录不修：start‖start 观察窗误报（终态正确仅错误文案失真，备查修复方向）、matchesScope 两个手工构造才达得到的 fail-open 边界、ui 查询无容错、sudo 密码窗 Ctrl+C 最长 60s 无响应。合并冲突文本层之外沿 clearProxyEnv 影响面连查两处同族语义缺陷：① v26.10.98 的 gh 回退按设计应与首选通道同经本机代理（「只换客户端不换路径」），但入口 `clearProxyEnv`（D9）会清掉指向本机 Mixed 的自指代理 env，gh 实际直连——回退局限注释与全失败时的换节点诊断均不成立；现 gh 候选由通道决策带上代理地址、下载时 per-spawn 注入，真 gh 实证 `proxyconnect` 生效。② update/doctor 的 npm 同样继承被清 env：shell `export https_proxy` 指向自己 Mixed 端口（Mixed 用户主流终端配置）时代理在跑却 npm 直连，手动 `npm install -g` 能成、CLI 包装的 update 反而失败；现清除时登记原值、npm spawn 前 TCP 探活，活才 per-spawn 注回（不凭空注入、.npmrc 优先；桩 npm 透传实测）。两者论证统一写入 D9。另补收 SECURITY.md/CLAUDE.md 旧命令名残留与一处与回退注释矛盾的测试描述。随后第七轮复审（高强度 code-review 过 v26.10.98 合入批次全量 diff）再修 8 项：doctor 把上游设计上永久保留的 meta-backup 误当「自升级残留」告警（常驻误报 + 修复命令连回滚备份一并删，上游行为已核对并记入结论节）——现拆为「残留 warn（仅 meta-update）」与「备份信息项」两条；kernel help 的通道顺序仍写旧「gh > 本机代理 > 直连」与实际决策相反；显式单候选（--mirror/--proxy/--mirror direct）全失败时被统一话术「全部下载通道均失败」掩盖原始 curl 错误、换节点指引也不适用——抽 buildDownloadFailureError 分档，单候选以原始错误为主消息；多候选中途切换行不带失败原因（原因原先只在全失败分支可见）；downloadKernel 兜底版本查询的 useGh 判据 apiProxy===null 使 direct/无代理 mirror 也先试 gh api、与通道语义相悖——resolveFallbackQueryOptions 纯函数对齐（direct 绝不经 gh）；gh 探测只在该结果参与决策的形态做（--mirror direct/--proxy 不再白花一次 spawnSync，ghProbeNeeded）；删除死导出 resolveDownloadChannel（spec 改用 channels[0]）；direct 通道不再多打孤立空行、失败汇总「本机代理/经本机代理」措辞与头部行一致。全量验证 typecheck / 854 测试 / Biome（96 文件，仅 1 个既存 noProto warning）/ build 全绿，发布为 26.10.99。

前一轮审查：2026-10-02，围绕内核升级链路（面板 `POST /upgrade` 与 `mihomo kernel`）的多轮深查，共修 4 项：下载通道优先级翻转为本机代理优先、失败自动回退 gh（回退只换客户端、节点通常不变，局限已写入 kernel.ts 注释）；curl 加 `--speed-limit/--speed-time` 低速 20s 快速失败，gh 超时 210s → 100s；新增 curl 退出码翻译（28=超时/低速，此前只显示裸退出码）；doctor 新增面板自升级残留检查（meta-backup/meta-update，区分性质）。根因记录：经代理下载的快慢取决于 url-test 选中节点对 Azure 的实际带宽，url-test 只按握手延迟选、不测带宽——CLI 层无法根治，全失败时提示手动换节点。全量验证 typecheck / 779 测试 / Biome（98 文件，仅 1 个既存 noProto warning）/ build 全绿，发布为 26.10.98。

前两轮审查：2026-10-01，全仓四域复审（服务/进程、配置/覆写、命令层、测试与元数据，四个子代理并行深审 + 主仓实跑）共修 7 项：sudo 超时改抛超时错误（不再漏 ETIMEDOUT 串）、SECURITY 移除已删除 tar 防线的描述、match 值加载期校验（url-domain 裸域名/name 字符集 + rules!+、+~rules 漏网形态）、帮助文案对齐（logs/version/sub use）与子命令名大小写归一、零消费者导出收口与 StopResult.killed 删除、CHANGELOG 1.x–3.x 原样归档 docs/changelog。全量验证 typecheck / Biome（98 文件，仅 1 个既存 noProto warning）/ build 全绿。四项修复与导出收口、CHANGELOG 归档一并发布为 26.10.97；发布区间第三轮复查另修 formatTimestamp 非法值（770 测试），同版本带出。

前三轮审查：2026-10-01，全仓复审（三路模块深审 + 用户接触面实跑）共修 16 项：覆写文件级错误诊断一致性、doctor/status 文案、死代码四删（withFileLock deadline 分支、forceSudo、uninstall 双 disable、测试专用 deepMergeWithOverrides）、残留内核清理统一到 cleanupAll、健康轮询关闭 print-disabled，以及六项体验打磨（超时订阅按跳过渲染、kernel/.tmp-* 清扫、零订阅口径、reset 近失提示、gh 回退明示、探测 3s 缓存）；合入后复查修掉清理统一引入的两处语义回退（无害 pid 文件让非 TTY stop 失败、uninstall user 残留退出码被收紧），处置判据抽 classifyResidueCleanup 锁四象限，并收窄 .tmp- 清扫只认 kernel/。上述 16 项发布为 26.10.95。其后复审 pid 清理链路并收口：两个提权脚本里的 `rm pid` 字面例外（buildKernelCleanupScript、legacy 迁移 buildLegacyCleanupScript）先后移除，pid 删除统一到「复核零进程才免提权 unlink、活进程保留」判据；同期拆分 CleanupResult 的脚本/pid 双错误字段、拦截裸 `-`、修正多处残留归因，发布为 26.10.96。上一轮 16 项见 26.9.93/26.9.94 CHANGELOG。全量验证 typecheck / 751 测试 / Biome（94 文件，非 0，仅 1 个既存 noProto warning）/ build 全绿。

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
- gh 回退通道必须带本机代理地址并 per-spawn 注入 env：v26.10.98 初版只在注释里假设「gh 继承同一代理」，但 main() 入口 clearProxyEnv（D9）会把指向本机 Mixed 的自指 env 删掉（shell export https_proxy 的最常见形态），gh 实际直连，回退定位与全失败诊断双双失准；现由 resolveDownloadChannels 给 gh 候选注入 proxy、buildGhDownloadEnv 只作用于该次 spawn（真 gh + 拒绝端口实证报 `proxyconnect`，通道形状与 env 构造由 kernel.spec 锁定）。gh（Go）只认 HTTPS_PROXY/https_proxy，无命令行代理选项
- 上游面板自升级（update_core.go）的 meta-backup 是有意永久保留的旧内核副本：成功路径只 defer 清理 meta-update、从不清 meta-backup（每次升级覆盖写，已核对上游源码）——doctor 只把 meta-update 当真残留告警，meta-backup 按信息项给独立删除口径，绝不与暂存共用一条 rm -rf（合并告警会让面板成功升级一次后 doctor 永久误报，修复命令还会连回滚备份一起删）
- npm（update 的 view/install 与 doctor 的版本检查）同样在 clearProxyEnv 后失去自指代理，但 npm 是用户环境工具、不由通道决策管辖：恢复策略与 gh 不同——recordClearedProxyEnv 只登记用户被清的原值，buildNpmSpawnEnv 每次 spawn 前 TCP 探活（0.0.0.0/:: 归一到确定回环地址，500ms 封顶），活才原样注回；null 记录（没清过）不凭空注入，探活失败（env 残留/内核已停）保持清除。桩 npm 透传 + 真实本地监听三态用例锁定；反向验证删掉注回即「端口在监听」用例转红、两个反例保持绿
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- 覆写文件级校验（已移除操作符/互斥/空键 + 数组操作符命中 BASE_CONFIG 非数组键）在 readOverwriteFiles 加载阶段执行：诊断旁路（ow/status）与合并闸门（start/config/doctor）看到同一份 broken 列表，坏文件的 hint 在三处文本与 status --json 都带出；依赖订阅当前值的冲突仍只在合并期报错（ow 不绑定订阅）
- 残留内核清理唯一入口是 cleanupAll（process-stop.ts）：stop/start/uninstall/reset 四个路径共用，root 残留走一次 sudo 脚本 buildKernelCleanupScript（只 pkill、不删 pid 文件），发信号后统一 5s 死亡等待再复核 pgrep——服务路径曾在发信号后立即复核、收割稍慢时误报「部分进程未终止」，随统一消除；sudo 取消/脚本失败经 CleanupResult 的 scriptError（pkill 脚本）与 pidError（pid 文件删除）两字段独立带出——进程死光但脚本没走完与仅 pid 文件残留是两种归因，合并成一个字段会让调用方提示说错事。**pid 文件清理免提权**：文件在 runtime/（用户属主目录、无 sticky bit），目录可写即可 unlink 其中任意文件、与文件属主无关，root 属主的 TUN 残留也直接删——走 sudo rm 是误把「文件属主」当成删除权限判据，白弹管理员密码；但 cleanupAll 路径**仅在复核 remaining 为空时才删 pid**：pid 文件是 isRunning/status 的真相源，sudo 被取消、root TUN 仍在路由时删文件会让 status 对活着的内核报「未运行」。该路径的提权脚本 buildKernelCleanupScript **只 pkill、不碰 pid**——旧实现在脚本里无条件 `rm pid`，仅靠「sudo 取消脚本不执行 + pkill 失败 exit 2」两道时序间接保证不删活进程，是该不变量在 cleanupAll 路径的字面例外，现已移除；root 属主文件由末尾免提权 unlink 收走（stop() 零进程分支也直接 clearPid）。**另一条提权路径 buildLegacyCleanupScript（清理旧 v3–v4 root LaunchDaemon）同样不碰 pid、现已收口**：旧实现在 `launchctl bootout` 之后无条件 `rm -f pid`，机器同时残留旧 plist（detectLegacySystemInstall 只查文件存在、不要求任务在跑）与无关活 root TUN 时，bootout 返回 113（未装载）后仍会删掉活 TUN 的 pid——到进程真正被收掉之间的窗口里并发 `mihomo-cli status` 对活 TUN 误报「未运行」，此刻 Ctrl+C 则凝固成「活 TUN + 无 pid」。现把脚本里的 rm 移除，pid 改由 cleanupLegacyInstallOrThrow 在 root 拆除成功后经 reapPidWhenQuiet 收口：等 launchd 收割后再复核 pgrep，**零进程才免提权 unlink，有并存的活 TUN 则保留其 pid**（status 真相源）。一处包装收口，stop/start/install/uninstall/reset 五个调用点都经它（函数改 async、调用点 await），不再逐点补兜底；零进程但删除失败只警告、下次 stop 再清。buildTunLaunchScript（TUN 启动）的 `rm pid` 是 pkill 旧实例后立即写新 pid 的自管流程，不在此列。服务层的处置判据唯一收口在 classifyResidueCleanup（service.spec 锁定三档及各字段组合）：root 清理失败且进程仍在（remaining + scriptError）→抛；无残留进程但有收尾错误→警告不拦命令（无进程读它、下次自愈）；用户态残留（remaining 非空、无 scriptError，含仅 pidError）→本层不抛，cmdStop 抛「部分进程未终止」、cmdUninstall 黄色提示退出 0、start 由健康确认兜底——pidError 是免提权 unlink 的小错，不参与 throw 分档。root 文案由 buildRootResidueCleanupError 按字段归因：remaining 的属主断言只跟随 scriptError（root 脚本没走通才说 root 残留）；remaining 为空时 scriptError 优先于 pidError——两字段并存（脚本没走完且文件也没删）时主归因随脚本、pid 错误仅附带，手动命令给 pkill 而非 rm（防漏掉潜在存活进程）；pidError 文案只说「未能清理」+具体错误、不断言属主；sudo 失败短语全仓共用 describeSudoFailure（非鉴权错误保留原始 message），pid 文件短语共用 describePidCleanupFailure——各写一份会漂移出多种说法
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

- **订阅下载不经任何代理**（既有产品边界，非本轮引入）：subscription 的 HTTP 客户端是 Node 原生 fetch（http.ts createHttpClient），undici 默认不读 http(s)_proxy/ALL_PROXY（Node 24 实测仍需 `NODE_USE_ENV_PROXY=1` 才认，本仓下界 22.22.1 更不支持），也没有按运行态经本机 Mixed 端口转发的逻辑；系统代理同样不被 fetch 识别。故 Mixed 模式 + 订阅主机直连不通的环境下 `sub add/update` 会失败——出路是 TUN 模式（整机流量进 utun，fetch 随之走代理）或换可直连的订阅地址。clearProxyEnv（D9）对 fetch 路径零影响（清不清都不读），与 gh/npm 的 env 代理缺口不同族。若要修是独立特性：undici ProxyAgent 按本机 Mixed 运行态注入 dispatcher（注意 fetch 当前在服务停后/未装时也应可用，不能无条件经自己端口）
- **remove/add 并发同名订阅的孤儿 yaml**（记录不修）：subAdd 的下载刻意不持 settings 锁（60s 下载不能压进临界区），A remove 完整提交时 B 的 yaml 尚未写出 → postCommit rm 落空 → B 随后写盘。终态「条目已删、孤儿文件残留」，无行为消费方（grep 证实无 subscriptions/ 目录枚举），仅 `dir open subs` 可见。要封死需下载完成后二次确认归属，收益不抵复杂度
- **stop 游离路径批量 pkill 与并发 start 的交错**（记录不修）：B 读 status（未装载）→ 并发 A bootstrap 并拉起服务内核 → B 读 pids 命中 A 的内核 → stop() 的 cleanupAll pkill 杀掉它，KeepAlive 约 10s 拉回（游离路径不 bootout）。B 报「已停止」与终态相反。与已接受的「探测与动作之间隔一次查询」同族（TUN sudo 窗口），方向相反（stop 伤 start），触发要求两次读取之间落入对方的 bootstrap+进程拉起，记录不修
- **TUN 启动的亚秒窗口内并发 stop 删 pid 文件**（记录不修）：TUN 启动脚本写完 pid 文件、内核尚未出现在 pgrep 的窗口内，并发 stop/reset 的零进程分支会删掉刚写的 pid 文件 → startTun 末尾 getPid() 为 null，把成功启动误报成「TUN 启动失败」。与上一条同族（探测与动作隔着一次查询），窗口亚秒级且旧 sudo 版同样存在（TTY 输密码即删），封死需要 start/stop 共享锁（跨进程锁在数据根目录、进程启动不在锁内），收益不抵复杂度
- **文件锁 stat→unlink 两步、不复核 inode**（已知理论缺口）：仅在等待者被冻结（合盖/换出）且系统时钟前跳时可利用，微秒级窗口，不为此加机制
- **sudo 密码窗口内 Ctrl+C 最长 60 秒无响应**（已知权衡）：三处提权（TUN 启动/残留清理/legacy 清理）的 `spawnSync('sudo', …, {stdio:'inherit', timeout:60s})` 阻塞主线程，期间信号处理器无法执行——与 process-stop.ts 头注释「轮询必须 async 保障 SIGINT 可达」的预期在此窗口相悖。改异步 spawn 需自行处理 sudo 子进程回收与 TTY 归属，复杂度远超收益；超时上限 60s 有界，非死锁，记录不修
- **ui 命令的 getRunningState 查询无容错**：launchctl 瞬时失败会把 `ui` 挡死报「无法查询服务状态」，与已修的 status/start 收尾同族；但 ui 是纯打开操作、失败重跑成本为零且打开后不再依赖该查询，按 status 修复前的同一姿态记录不修——若将来 ui 增加依赖运行态的分支，先补容错
- **上游 MetaCubeX/mihomo 的默认分支已变更为 main，且 main 是一个同名 Python 项目**（2026-09-30 起，pushedAt 与 description 均证实）；内核源码与发布仍在 Meta 分支，release 由 github-actions 持续发布（v1.19.31/v1.19.32）。**对 CLI 无影响**：版本查询与下载走 releases API（tag 固定，资产 URL 不变，D8 的来源钉死不受默认分支影响）；受影响的是任何不带 ref 的 contents/tree API 调用——拿到的是 Python 项目。上游源码核对（锁定清单对表）必须带 `?ref=Meta`（config-inbound-snapshot.spec 的引用已带）。若未来 release 停止更新或资产消失，再评估换源
- **start‖start 互替的观察窗误报**（全对枚举推演确认，记录不修）：A 已通过锁内 bootstrap、处于健康观察窗（1.2–3s、锁外）时，B（连敲的第二次 start/sub use/ow 重启）完成 bootout+bootstrap 把 A 的任务换成自己的——A 的轮询读到 unloaded → 报「内核未能进入运行状态」附日志尾部，而终态正确（B 的内核在跑）。触发要求 B 的全程落进 A 的观察窗（慢机器/连敲重启）；B 是 start 不 bump epoch，失败复读判据抓不到它。修复方向（备查）：健康轮询最终 healthy:false 分支复用 healthViaProcessProbe 兜底——B 的内核进程在则判 healthy（PID 是 B 的，用户视角代理确实起来了）；代价是健康判据再增一个消费语义，与「崩溃循环 isCrashed 先判」的现序兼容但复杂度上行，损害仅错误文案的排查方向，记录不修
- **matchesScope 的两个 fail-open 边界**（fuzz 差分定性，记录不加防御）：`match.name: ''`（空串 falsy 被跳过 → 无条件应用）与单独 `'*'`（头部 `*` 分支 slice 出空串 → endsWith 恒真）在函数层可达恒真语义；README 承诺的「空值报错、单独 `*` 报错」在文件加载期（normalizeMatch）拦截，真实文件路径到不了 matchesScope，仅手工构造 Entry 绕过加载期可达。收益不抵复杂度
- **锁定清单已于 2026-10-02 对照 v1.19.32 重新核对**：config.Inbound + RawConfig 入站/控制面键集与 v1.19.30 快照无差异（新增面孔 clash-for-android/etag-support/keep-alive 家族/ntp/global-* 均不开监听），快照版本标注刷新为 v1.19.32
- **原子写 fsync/fchmod 的文件系统边界**：非常规文件系统（如 NFS home）上 fsync 可返回 EINVAL，fchmod 是第二个硬失败 syscall（ FAT/exFAT 类权限位无意义）；两者都使原本 rename-only 能成功的写入整体失败——与 fsync 同一姿态接受，服务层不用感知——macOS APFS 实测无问题，未在其他文件系统实测。保证范围分层写在 atomicWriteFileSync docstring；崩溃遗留 `*.tmp` 的清扫在三道守卫与豁免判定**之后**执行（清扫是删除动作，不在被拒绝/豁免的命令上跑）
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
- 单个覆写文件的 `enabled` 写错会让 `mihomo-cli status`、`ow` 整体失败（经 `listOverwriteFile` → `loadOverwriteFile` 抛 CliError）。与 `match` 写错的现有行为一致、不是新退化，可接受的前提是错误消息带文件名（已有用例锁住）
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
- **reset 确认后重读仍有的残余窗口**（终审推演确认，记录接受）：危险分支（重读时 serviceActive=false）里，重读之后到删除 kernel/config 之间还隔着 cleanupAll 的 root 残留提权（sudo 密码窗最长 60s）；serviceActive=true 分支还隔 stop/uninstall 自身的锁等待（≤10s）与 bootout+waitUntilUnloaded（≤5s）。并发 install+start 整体落进这些窗口时其锁内判定放行（epoch 基线取自最近 bump 之后），删除后 KeepAlive 崩溃循环——与「stop 游离路径」同族同方向，但触发窗在有 root 残留时是秒到 60 秒级。不修的理由：删除前再读再 stop 会引入第二层窗口（uninstall 自身窗口内又可有并发，无穷回归），且触发需「root 残留内核存在 + 并发 install+start 恰在窗口完成 bootstrap」双重前置；若将来 reset 支持并发场景，优先考虑把删除段并入 serviceLock 临界区
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
