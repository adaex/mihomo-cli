# Changelog

## [4.7.3] - 2026-09-06

清掉 CODE_REVIEW 积压的全部未处理项（一条修复、一条决策豁免）。单测 283（+37）。

### 修复

- **TUN 模式下 `dns.enable: false` 生成自相矛盾的配置**：订阅/覆写显式关闭 DNS 时，生成的配置一边写 `dns: {enable: false}`、一边保留 `tun.dns-hijack: [any:53, tcp://any:53]`，还往已关闭的 dns 块里补注 fake-ip 字段。TUN 劫持 53 端口而内置 DNS 关着，没有任何组件接管，网络直接不可用。现把 `dns.enable` 视为 TUN 下的系统锁定项（与 `external-controller`/`mixed-port` 同一性质）强制为 `true` 并给出告警。不选「拒绝启动」是因为该值常由机场下发、用户改不了，硬拒绝等于逼用户先学会写覆写文件才能用 TUN；**只锁 `enable` 一个键**，`nameserver`/`enhanced-mode` 等仍尊重用户配置
- **信号死亡的内核对 `status`/`doctor` 完全不可见**：被 OOM killer 或 `kill -9` 干掉时，launchd 只写 `last terminating signal = Killed: 9`，`last exit code` 整行消失（实测 macOS 26.6，两字段互斥）——而解析器只读退出码，于是用户看到「不在运行」却没有任何异常提示，实际 KeepAlive 正每隔约 10s 反复拉起。现 `parseServicePrint` 解析该字段，崩溃判据两者取一。顺带把 status/doctor 里三处重复的「上次异常退出」判断收口成 `describeAbnormalExit`——此前补一条判据要同步改三处
- **`dns` 形态校验只有 TUN 一条路径有**：mixed 下 `dns: true` 一类订阅笔误照样抛裸 `TypeError` + 堆栈，被当成程序 bug。校验下沉为 `assertDnsShape`，两条路径共用
- **全是预发布版时 `pickLatestRelease` 回退首个 release**：会把 alpha 当稳定版装上。今日不可达（上游同时只挂一条 alpha），但内核以 root 身份跑（TUN）或长期常驻，静默降级到未发布版本不可接受，现直接抛错

### 测试

- **新增 `process-stop.spec.ts`（12 例）**：真起桩进程、真 `pkill`，覆盖 `cleanupAll` 的单杀/批量（>3）分支、符号链与真实二进制两种命令行形态、`stop` 的 notRunning 语义、`isRunning` 的 PID 复用防线。无侵入——`MIHOMO_CLI_DIR` 指向 tmpdir 后 `MAIN_INSTANCE_PATTERN` 内嵌的绝对路径使其物理上不可能匹配到用户真在跑的内核，**该前提本身有一条用例断言着**（pattern 若改成不含绝对路径，测试当场失败而非静默扩大杀伤范围）
- 新增 `config-dns.spec.ts`（15 例）锁定 TUN dns 锁定语义与两条路径的形态校验；`service.spec.ts` 补信号死亡的真实 launchctl 输出 fixture 与 `describeAbnormalExit`

### 变更

- **`CODE_REVIEW.md` 未处理项清空至一条**（剩「观察窗之后才崩溃的内核判不出来」，属有意边界）。sudo 路径与 launchd 端到端测试**升格为显式决策豁免**并写明理由：前者要么配免密 sudoers、要么改系统路由表、要么留 root 残留；后者一旦覆盖 `enable`/`disable` 就会在系统 disabled 表留下 launchctl 无法清除的永久记录。下轮审查不要当作覆盖率缺口重新捡起
- **README 同步两处用户可见行为**：TUN 章节说明 DNS 恒为开启（含只锁 `enable`、Mixed 不受影响）；故障排查章节说明「上次异常退出」提示会区分 `退出码 N` 与 `被信号终止（Killed: 9）`

## [4.7.2] - 2026-09-06

文档修正，无功能变更。单测 246。

### 修复

- **README 数据目录注释仍写「镜像偏好」**：v4.7.0 移除 `settings.kernel_mirror`、镜像改为每次按当前环境独立决策后，README「内核更新通道」一节已同步（写明不持久化），但数据目录树里 `settings.json` 的注释漏改，4.7.1 修 quickstart 章节时也未覆盖到。现按 `Settings` 接口实际字段列举（订阅列表、当前订阅、覆写开关、端口覆盖）

### 变更

- **`/wt-done` 补接手场景**：会话中断后由新会话收尾时 cwd 不在 worktree 内，流程第 2 步 `ExitWorktree` 是 no-op，注明可跳过、直接在主仓合并

## [4.7.1] - 2026-09-06

文档与 AI 资产整理，无功能变更。单测 246。

### 变更

- **CLAUDE.md 补表格漂移**：命令处理器表补 `doctor`/`completion`、架构表补 `src/flags.ts`，与 registry 实际注册对齐
- **CLAUDE.md 新增 quickstart.sh 锚点**：明确它是内核下载的 shell 平行实现，改下载/信任逻辑须与 `kernel.ts` 双向同步；已知分歧（默认镜像、无标准版回退、支持 linux 等）标注为刻意
- **CLAUDE.md ↔ CODE_REVIEW.md 去重划界**：规则以 CLAUDE.md 为唯一真相源，CODE_REVIEW 只记验证结论与未处理项，重复条目改为指针；`service.lock` 规则补进 CLAUDE.md
- **CODE_REVIEW 基线更新到 v4.7.0**，单测数同步为 246，清掉已修条目的删除线残留
- **ssh 恢复用法移至 README**（「用 ssh -D 做节点」），CLAUDE.md 保留防重提结论
- **新增项目级命令** `/release`、`/wt-done`（`.claude/commands/`，随仓共享），发布与 worktree 收尾流程固化为可执行指令
- 删除空壳 TODO.md（职责并入 CODE_REVIEW 未处理项）

## [4.7.0] - 2026-09-06

内核下载多通道：gh > 本机代理 > 直连。单测 246。

### 新增

- **内核下载自动选择通道**：默认按 gh（GitHub CLI 直连 GitHub）> 本机代理（代理在跑时经混合端口直连，TLS 端到端）> 直连 的顺序选择，国内网络下不再只能手动敲 `--mirror`。显式 `--mirror`/`--mirror direct` 是最高优先的手动覆盖（`--mirror direct` 同时绕过 gh/代理自动通道）
- **版本查询（GitHub API）经本机代理**：代理开着时 `checkUpdate` 也走混合端口，不再卡在 API 检查这一步。镜像仍绝不作用于 API——下载地址必须由 GitHub 官方 API 给出
- **镜像默认按网络选择**：裸 `--mirror` 有 IPv6 时走 `v6.gh-proxy.org`，否则走 `gh-proxy.org`；短别名 `--mirror cdn|v4|v6|axisnow` 直接指定。可用镜像为 gh-proxy.org / v4 / v6 / cdn / axisnow.gh-proxy.org
- `mihomo kernel` 下载前打印当前通道；下载失败时提示通道优先级与手动覆盖用法

### 变更

- **镜像偏好不再持久化**：`--mirror` 只作用于本次调用，不写入 settings——每次按当前环境独立决策（gh/代理是否可用、网络是否有 IPv6），换网络不会用到上次的镜像。`settings.kernel_mirror` 字段移除
- **`--no-mirror`/`--direct` 移除**：强制直连统一走 `--mirror direct`；旧选项显式报错并给迁移指引，不静默按直连继续

### 安全

- **gh 通道的信任锚**：`gh release download` 只与 GitHub 通信，资产名精确匹配（`--pattern` 是 glob，含 `*?[]` 或路径成分一律拒绝）；大小比对、tar 双守卫、自检、版本对账对所有通道一视同仁

## [4.6.0] - 2026-09-05

全面审查修复：内核更新安全、服务操作并发、订阅下载防降级、补全死代码、循环依赖等 30 项。单测 234（无新增，本轮以修复为主）。

### 修复（中高）

- **内核更新先自检再替换**：此前 `.gz` 路径先删旧内核再自检，自检失败时系统无内核可用（KeepAlive 崩溃循环）；且 `findBinaryInDir` 扫描整个 kernel 目录，归档不含二进制时会选中旧内核自检通过、报「已更新」但二进制没变。现改为解压到临时目录 → 自检 → 版本对账 → 原子替换，旧内核在新内核验证通过前不受影响
- **订阅下载防 https→http 降级**：Node fetch 默认静默跟随协议降级重定向，恶意 WiFi/路由器可 MITM 替换订阅配置。内核下载有 `curl --proto =https` 防线，订阅下载没有。现 fetch 后检查 `response.url` 协议，降级即报错
- **zsh 补全 `dir open <TAB>` 死代码**：group 循环生成的 directory 分支与硬编码分支同名，zsh 取第一个匹配，硬编码的目标补全（`root/subs/logs/...`）永不可达，`dir open <TAB>` 补的是本地文件。bash/fish 正常，只有 zsh 坏
- **`shared.ts` ↔ `start.ts` 循环依赖**：`cleanupLegacyInstallOrThrow` 在 shared.ts 造成 shared ↔ start 运行时循环，注释声称「无循环」已过期。移至 service.ts（`cleanupLegacySystemInstall` 所在地），依赖方向恢复单向
- **`maskUrl` 黑名单改启发式**：黑名单只有 8 个参数名，`uuid`/`sid`/`id` 等常见 token 参数不遮蔽。改为「值长度 ≥16 的 query 参数一律遮蔽」+ 扩充黑名单，误伤率低、token 几乎都是长串

### 修复（中）

- **服务操作跨进程锁**：慢速 `start`（订阅更新 ~10s）期间另一终端 `stop`，start 随后的 `enable` 会把自启位又打开，终态与用户最后一条命令相反。`startService`/`stopService`/`installService`/`uninstallService` 的 enable/bootstrap/bootout/disable 现共持 `service.lock`；start 在锁内再查一次 disabled，若 stop 已跑完则跳过启动
- **`sub add` 补重启提示**：成功切换订阅后运行中实例仍用旧配置，`subUpdate`/`subUse` 都有提示，唯独 `subAdd` 漏了
- **`update` 防静默降级**：当前版本领先 registry（预发/源码安装）时 `npm install -g` 会静默降级。现用 `compareVersions` 比对，领先时跳过并提示
- **未知 flag 校验**：`start`/`logs`/`ow`/`sub`/`status` 此前不校验未知 flag，拼错（`logs -F`）被静默跳过。新增 `assertKnownFlags` 通用校验，白名单外的 flag 一律报错
- **`--no-ssh` 全局检查**：此前只在 `start`/`stop` 报错，其他命令静默忽略。移至 `index.ts` 守卫后、分发前统一检查
- **attached 短选项**：`logs -n200`、`start -u5000` 此前被静默忽略（`parseIntArg` 只认 `-n 200` 和 `--lines=200`）。现支持 `-n200` 形式
- **日志轮转撞名**：同一秒内两次轮转（start 失败后立即重试）会互相覆盖归档。`rotateLog` 和 `restartService` 的 copy-truncate 都加了序号后缀
- **`tryHotReload` pid 校验**：`/version` 探针只确认「端口上是个 mihomo」，挡不住「另一个 mihomo」。新增 `lsof` 取监听 pid 与服务 pid 比对
- **`cleanupLegacySystemInstall` 不再 `|| true`**：`launchctl bootout` 的 `|| true` 吞掉所有错误，daemon 仍在跑却继续 rm plist 并报「已清理」。现只容忍退出码 113（未装载），其余按失败处理
- **ANSI 转义消毒**：服务器返回的字符串（订阅名、错误信息、Content-Disposition）可能含 `\x1b[2J` 等转义序列伪造 CLI 输出。新增 `sanitizeTerminal`，在入口点消毒
- **`parseYamlOrJson` 校验非对象**：JSON 回退路径此前不校验结果类型，标量/数组也能返回。现与 YAML 路径同构，只接受对象
- **`buildConfig` 深拷贝**：`applyOverwrite` 只做浅拷贝，`excludeOverwriteProxiesFromIncludeAll`/`validateConfig` 原地改嵌套对象，污染 `subscriptionConfig` 导致 debug stage1 失真。现深拷贝后再传
- **`saveSubscriptionCache` 防展开垃圾**：损坏的非对象条目（字符串）被 `{...}` 展开成字符键垃圾。现检查类型后再合并
- **`removeSubscription` 锁内删文件**：原始配置的 rm 此前在锁外，与并发 `sub add` 同名存在 TOCTOU。现挪进 `updateSettings` mutator（锁内）

### 修复（低）

- **`sub use -s foo` flag 顺序**：`args[2]` 直取改为 `getNonFlagArg`，flag 写在名字前不再报「未找到订阅」
- **`completion install` 落盘失败包 CliError**：此前抛裸 Error 带完整堆栈，现包成友好提示
- **doctor 内核自检区分 spawn 错误**：`spawnSync` 失败（EACCES/ENOENT）时显示「退出码 null」，现区分 spawn 错误与非零退出
- **`reset` 多目标空目标不报成功**：多目标时空目标（如内核未安装）无删除却出现在成功文案里。现跟踪实际删除的目标
- **`reset overwrites` 关闭覆写开关**：删了覆写文件却留着 `overwrite_enabled=true`，ow/status 显示「已启用 (无文件)」。现重置开关
- **`reset logs` 运行中先停服务**：`needsStop` 从 false 改为 true，避免内核继续写已删 inode
- **补全词表补别名**：顶层补全此前只建议命令主名，不建议 `sub`/`ow`/`dir`/`restart` 等别名。bash `logs` 补全建议不存在的 `--help`，改为 `--lines`/`--follow`/`--open`。三 shell 的 `completion` 分支补 shell 名
- **`mihomo log 1` 尊重编号**：隐藏别名 `log` 的 rewrite 硬编码 `'0'`，`log 1` 跟随当前日志而非归档 1。现尊重用户传的编号
- **startTun 文案**：仅有 root pid 文件无进程时不再打印「清理 0 个残留进程」，改为「清理残留的 root pid 文件」

### 文档

- **TODO.md**：删除「Mixed 模式系统代理开关」条目——该功能已被 owner 在 v4.5.0 明确否决（CLAUDE.md 决策记录），TODO 条目会误导后续实现
- **CLAUDE.md 架构表**：补 `proxy-probe.ts` 和 `spinner.ts` 两个模块（v4.3.0 新增，文档未同步）

## [4.5.0] - 2026-09-05

产品面打磨：补齐「服务常驻」与「用户会回来敲命令」假设之间的缺口。单测 229 → 234。

### 新增

- **`status` 订阅新鲜度**：订阅块新增「更新: N 小时前」行，超过更新间隔时黄标并建议 `mihomo sub update`——服务常驻期间订阅不会自动更新（launchd 只拉起内核，不跑 `start`），陈旧订阅是「运行中（代理不通）」的高频根因。`--json` 的 `subscription` 补 `updatedAt`/`stale` 字段。判断收敛为 `isSubscriptionStale` 纯函数，与 doctor 订阅新鲜度共用口径

- **`sub add` 剪贴板**：交互下不带 URL 参数时自动读取剪贴板（pbpaste），`maskUrl` 遮蔽展示 + y/N 确认后添加——「机场页面点复制 → 终端粘贴」不再需要重打一遍命令。剪贴板非 URL / 非 TTY 环境维持原有报错

- **端口逃生口**：`settings.json` 新增 `ports: { mixed, controller }`，可覆盖默认 7890/9090（与其他代理工具并存的场景）。`getPorts()` 为唯一解析入口，非法值（非 1-65535 整数、两端口相同）直接抛错而非静默回退默认——端口突降会让热重载/UI 连错地址且毫无线索。配置构建、热重载、`ui` 提示、`start` 系统代理提示、doctor 端口检查全部跟随实际值；订阅/覆写仍不可改端口（系统锁定语义不变）

- **`completion install <shell>`**：一键安装补全到对应 shell 的默认位置（zsh → `~/.zsh/completions/_mihomo`，bash → 追加 `~/.bash_completion` 含幂等标记、不覆盖已有内容，fish → `~/.config/fish/completions/mihomo.fish`）。zsh 不自动改 `.zshrc`，fpath 缺失时提示用户补一行。三 shell 的补全词表同步支持 `install` 子命令

- **doctor CLI 版本检查**：落后于 npm latest 时 warn 并提示 `mihomo update`（短超时 4s，registry 不可达静默跳过，不产生红色噪音）——本项目连修多个高危缺陷，老用户需要被提醒升级

### 变更

- **doctor 增加 ports 合法性检查**：`settings.ports` 非法（超范围/非整数/两端口相同/非对象）时报 ✗ 检查项并给修复指引，而不是让整个体检崩在半路
- **`uninstall` 收尾提示彻底清理**：卸载只移除 launchd 托管，结束时提示 `mihomo reset --full`（删数据）与 `npm uninstall -g mihomo-cli`（删包）两步
- **`start` 系统代理提示跟随实际端口**：文案硬编码的 7890 改为 `getPorts().mixed`（配置逃生口后提示不会指错端口）
- **README**：「订阅自动更新」节写实「服务常驻期间不会自动更新」及对策；覆写配置节新增「同时使用多个机场」的 `proxy-providers` 完整示例（单活跃订阅模型下并入第二机场的正路）

### 决策记录

- **不自动配置系统代理、不提供 `proxy on/off` 开关**（owner 决策，记入 CLAUDE.md 服务模型既定决策）：owner 的用法是「日常只有部分程序需要代理，需要者各自配置」，全局代理是错误状态。Mixed 启动保持只提示端口

## [4.4.0] - 2026-09-05

工程去重与安全加固：消除补全词表的第二真相源，doctor 连通性/设置校验复用核心模块，quickstart.sh 对齐 CLI 的安全水位。单测 225 → 229。

### 新增

- **`status --no-probe`**：跳过连通性探测（脚本场景或已知不通时避免 2s 等待）；`--json` 同样支持
- **`start` Mixed 模式提示系统代理**：启动成功后提示「需在系统设置配置 HTTP/SOCKS 代理 127.0.0.1:7890」（TUN 模式无需）——进程活着 ≠ 流量走代理
- **doctor 服务崩溃循环告警**：装着、自启开着、却没在跑且上次非 0 退出时判异常（此前与「用户主动 stop」混为 ok）

### 变更

- **补全词表从注册表派生**：`completion` 的命令/子命令词表不再手写，从 `COMMANDS` 与各命令导出的 `SUBCOMMANDS` 派生（`SubCommand` 加 `description`），新增命令自动进补全；`Command` 加 `hidden` 标记，墓碑命令与隐藏别名不再进词表
- **doctor 连通性复用 `probeProxyConnectivity`**：删掉同步 shim（curl 参数漂移风险），`collectChecks` 改 async；settings 校验复用 `isValidSettingsContent` 纯函数（与 `readSettings` 的损坏恢复同源）
- **doctor 未运行项改中性**：代理连通在未运行时从 ok「未运行，跳过」改为 skip（`·`），汇总单列「N 项跳过」
- **连通性探测超时 5s → 2s**：status 是高频命令，代理不通时不该每次干等 5s
- **订阅更新间隔统一 12h**：删 `isGithubUrl` 与 `DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB`——国内直连 GitHub 更难，更频繁地撞墙只产生失败噪音
- **`update` EACCES 提示去 sudo**：改为「检查 npm 全局目录权限或使用 nvm」，与项目拒绝 sudo 运行的立场一致
- **`status` 复用服务查询**：`getRunningState` 接受可选 `ServiceStatus`，printStatus 一次查询多处复用，省一次 launchctl print + print-disabled

### 安全

- **quickstart.sh 对齐 CLI 安全水位**：内核资产精确匹配标准版命名形态（不再黑名单枚举后缀变体，`-v1` 微架构变体不会再被选中）；tar 解压前双守卫（`-tzf` 查路径穿越 + `-tvzf` 拒符号/硬链接）；curl 全链路强制 https（`--proto '=https'`）；订阅内容校验含节点来源；下载 URL 钉死 GitHub 白名单

## [4.3.0] - 2026-09-05

用户体验打磨：把「成功路径」的确认从「进程活着」推进到「代理真的通」，补齐首次上手引导与自助排障。单测 203 → 225。

### 新增

- **`mihomo doctor` 体检命令**：逐项检查内核可执行性、数据目录可写、settings 有效性、订阅配置与新鲜度、服务状态（含遗留 root 服务）、端口占用、配置可构建性、代理连通性，每项 ✓/!/✗ 并附修复命令；有异常项时退出码 1

- **`mihomo completion <zsh|bash|fish>`**：生成 shell 补全脚本，覆盖全部命令、订阅/覆写/目录子命令与常用选项

- **代理连通性探测**：`status` 与 `start` 结尾的状态展示从二态变三态——运行中但经混合端口发不出真实请求时显示「● 运行中（代理不通）」黄灯，并归因到订阅过期 / 流量用尽 / 节点失效（`src/proxy-probe.ts`，curl 经 127.0.0.1:7890 请求 gstatic generate_204）

- **`status --json`（`-j`）**：机器可读的状态快照（运行状态、连通性、端口、订阅流量/到期/紧急度、服务位），供菜单栏 widget 等脚本集成

- **`mihomo use <name>`** 顶层快捷命令（= `subscription use`，与 `tun` 快捷方式同范式）；`mihomo restart` 作为 `start` 的别名（start 本身即重启）

### 变更

- **首次上手引导**：无参运行的短帮助从静态清单改为上下文感知——缺内核/订阅/服务时按顺序列出「开始使用」步骤，齐全后才显示常用命令；`status` 的「内核: 未安装」「订阅: 未配置」补上行内修复提示

- **`kernel --mirror` 记住偏好**：显式 `--mirror`（裸或带值）把镜像写入 settings，之后裸 `mihomo kernel` 默认走镜像；`--no-mirror` 本次直连并清除偏好。国内用户不必每次更新都带参数

- **状态紧急度着色**：订阅到期 7 天内黄色、过期红色；流量 >=90% 黄色、用尽红色

- **长操作等待反馈**：订阅添加/更新、内核版本检查、CLI 自更新查询在 TTY 下显示转圈动画与计时，非 TTY 降级为静态行（`src/spinner.ts`）

- **`ui` 密钥顺手复制**：配置了 `controller_secret` 时自动 `pbcopy` 到剪贴板，失败回退原提示

- **订阅列表相对时间**：更新时间显示「绝对时间（3 小时前）」，对「该不该更新」更直观

## [4.2.4] - 2026-09-05

内部架构清理，无用户可见的功能或行为变更（命令、配置格式、输出均不变）。单测 195 → 203。

### 重构

- **service 层去 bash 化**：用户域 launchctl 操作（install/start/stop/uninstall/restart）从「拼 shell 脚本 + 自定义退出码协议」改为直接 `spawnSync` 逐条执行、TS 侧判定。消除了退出码协议这层不可测的 IPC 与 shell 注入面，失败时错误信息带 launchctl 原始 stderr。需要 root 的路径（TUN 启动、遗留清理）保留 sudo 脚本。`waitUntilUnloaded` 改为 async 轮询，停止期间 Ctrl+C 可响应

- **命令行选项单表登记**：新增 `src/flags.ts`，`VALUE_FLAGS`（位置参数解析跳过带值选项）与重启透传集合都从单一 `FLAGS` 表派生，替掉 utils.ts 的两张硬编码表——旧设计漏登记即静默失效（`sub use foo -s` 丢选项、`logs -n 200` 的 200 被当位置参数）

- **删死代码**：`http.ts` 未使用的 `secret` 选项（零调用，控制器 Bearer 鉴权一直在 service.ts）；合并 root/平台守卫的重复豁免名单；`getProcessInfo` 的两次 `ps` 合并为一次

### 文档

- CLAUDE.md 瘦身：与代码注释重复的事故叙事换成指针，只留稳定规则与元教训；两条独有的 launchd 实测事实（`plutil -remove` 手工收尾、`KeepAlive.PathState` 否定结论）移入 CODE_REVIEW.md

## [4.2.3] - 2026-09-05

四维度全面扫描（launchd 服务 / 进程生命周期 / 数据层 / 命令层）后修复九项缺陷。共同模式是**防线只铺在主路径**：此前几轮修掉的「报告成功但目标未达成」，同类缺口在 install / tun / stop / uninstall 这些次路径上原样存在。每条都经真实系统实验或复现验证（真实 launchd、三进程锁竞态、真实 release 资产列表），并补了 17 条回归测试（单测 178 → 195）。

### 修复

- **`install` 重装恢复运行不再谎报**。重装时若服务原本在跑，装完会恢复运行并打印「已按原状态重新启动」——但判据只有「bootstrap 没报错」。这正是 v4.2.0 给 `start` 修掉的崩溃循环缺陷（launchd 装载成功 ≠ 进程活着），修复当时只铺到了 start。现在重装路径复用同一套健康确认（观察满 1.2s 窗口），失败时附日志尾部，并明确告知「服务已安装成功，仅恢复运行失败」

- **TUN 启动判据重写**。此前脚本的验证循环是 0.4s 单次检查、首次存活即收口——实测内核可在启动后 180–540ms 才退出，必然漏检；且 `kill -0` 对僵尸进程（bash 尚未收割的已死子进程）同样返回成功，桩进程实测 10 次中 5 次误报存活。现在观察满 1.2s 窗口（与服务路径对齐），判活以 `ps` 的状态列为准（Z 开头或查不到都算死），CLI 收口复核进程真实存活而非只读 pid 文件

- **`stop`/`uninstall` 停不干净时如实报错**。`waitUnloadedSteps` 此前只有等待、没有判定——bootout 未生效时轮询 25 次后静默放行，而任务仍装载着，KeepAlive 约 10s 后把内核拉回，CLI 早已打印「已停止」。现在轮询用尽仍装载即报错；`launchctl` 查询失败（112/125）也不再被当「已卸载」。uninstall 还补上了这段等待，plist 删除失败不再被吞

- **`launchctl disable` 不再吞错**。它是「TUN 用完不 stop 直接关机 → 下次开机崩溃循环」防线的第一层，也是开机自启路径上的唯一一层，此前却整体 `|| true`——失败时 CLI 照常提示「已关闭自启」。现在执行后经 `print-disabled` 复核位真生效，失败可见

- **`stop`/`tun`/`reset service` 认得遗留 root daemon 了**。v4.0 及更早装的 root LaunchDaemon 带 KeepAlive，`stop` 此前只停用户级服务——root 内核被杀后约 10s 就被拉回，「已停止」成谎报；`reset service` 在仅有 legacy 安装的机器上报「已重置」却原样保留。现在三处与 install/uninstall 一致：检测到即引导清理（需要一次管理员密码，sudo 取消会得到可读的错误而非堆栈）

- **文件锁的释放校验所有权**。锁被强夺后（持锁超 10s），原持有者退出临界区时的 `finally` 会无条件删除锁文件——删掉的是**新持有者**的锁，第三方随即直接进入临界区。三进程实测：B/C 并发 4.6s，发生的正是锁要防的静默丢数据，且双方都拿到成功回执。现在锁文件写入 `pid+hrtime` 标识，内容一致才删

- **Intel Mac 不再静默装上最低性能档的内核**。上游 release 同时提供 GOAMD64 微架构变体（`-v1`/`-v3` 后缀），而资产按名称排序时 `-v1` 变体恰好排在标准版之前——旧的判据只排除了 `-go`/`-compatible`，漏了它。于是每次内核更新都装上 baseline 构建，下载、大小校验、自检全部通过，CLI 报「已更新」。现在精确匹配标准版命名形态，任何后缀变体都不会再被选中

- **覆写 `match` 写错直接报错**。键名拼错（`subscripton`）、值滤空或空块时，此前只 warn 一声然后**对所有订阅生效**——用户写了 match 显然是想限定作用域，静默放宽比报错危险得多。现在加载侧与运行侧一致 fail-closed

- **`~proxies` patch 已有节点不再把它踢出自动分组**。patch 订阅已有节点的字段（`~` 的正当用法）不注入新节点，但旧实现照把节点名收进 exclude-filter——节点本就在池子里，被排除后反而从所有 include-all 分组消失，分流静默改变。现在只排除真正新增的节点



三个「报告成功但其实没做到」的缺陷，均实测复现并回归验证。都是 v4.2.1 那个 pgrep 缺陷的同源问题：把「调用没报错」当成「目标达成」。

### 修复

- **`sudo mihomo …` 会静默失效，现在直接拒绝**。服务是用户级 LaunchAgent，域为 `gui/<uid>`；sudo 下 uid 是 0，域变成 `gui/0` —— 一个不存在的域，实测 launchctl 一律返回 125（`Bad request`）而非「未找到」。而 `stopService` 的每条命令都带 `|| true`，125 被吞掉、脚本退 0，CLI 报「已停止」。实际只有杀进程那步生效，plist 的 `KeepAlive` 约 10 秒后又把内核拉了回来（实测 pid 从 52251 变成 52693）。用户看到的是「停了一下又活了」，且自启也没关掉。

  现在以 root 运行时直接报错并引导去掉 sudo（`help`/`version` 豁免）。守卫先于 `ensureDirs`，避免在 `/var/root` 建出一套用户永远看不到的数据目录。不做「读 `SUDO_UID` 回落到真实用户域」的自动降级：sudo 下 `HOME` 是否保留取决于 sudoers 配置，静默改域只会让错位更难查。

  同时收紧了 launchctl 的退出码处理：只有 `113`（目标未找到）才等于「服务未装载」，`112`（域不存在）与 `125`（请求非法）是查询本身没成立，一律报错。

- **TUN 未停就关机，下次开机内核会陷入崩溃循环**。plist 与 TUN 共用同一份 `runtime/config.yaml`，TUN 一跑那份配置就是 `tun.enable = true`。若服务自启还开着，重启后 launchd 会拿这份 TUN 配置、以普通用户身份启动内核 —— 而创建 utun 设备需要 root，内核必然失败退出，再被 `KeepAlive` 每约 10 秒拉起一次。用户开机只看到「代理不通、日志被刷爆」，与上次用过 TUN 毫无表面关联。

  现在 `mihomo tun` 启动前会自动关闭服务自启并提示，TUN 用完后 `mihomo start` 恢复。另加一层兜底：`startService` 拒绝以 TUN 配置启动，防御用户手工改配置或从旧版本升级带来的同种状态。

- **`pkill` 失败仍被记成「已杀掉」**。`killAllMihomo` 无条件返回 true，不看退出码；批量分支还无视返回值直接把 `killedCount` 记成全部。v4.2.1 的 pattern 缺陷正是靠这里才把「一个进程都没杀」统计成「全部杀掉」。现在 pkill 只接受退出码 0（已发信号）与 1（无匹配），2/3 视为失败。

## [4.2.1] - 2026-09-05

修一个让 `stop` 完全失效的高危缺陷。实测复现并回归验证。

### 修复

- **`mihomo stop` 停不掉内核，却打印「不在运行」并退出 0**。内核照常在跑、代理照常生效，只是自启被关掉了——下次开机才「看起来正常」。同一个缺陷还让 `status` 把运行中的内核报成未运行、`start` 看不见需要清理的残留、`reset` 漏掉进程清理。

  根因在识别内核进程的正则：它用了 JS 的非捕获组 `(?:a|b)`，而 `pgrep -f` / `pkill -f` 走 POSIX ERE（`regcomp(REG_EXTENDED)`），ERE 里 `(` 后紧跟 `?` 是语法错误。实测 `pgrep` 直接报 `Cannot compile regular expression ... (repetition-operator operand invalid)` 并以退出码 2 结束、不输出任何 PID，而 `getMihomoPids()` 把这个失败吞成了「没有进程」。`pkill` 同样编译失败，一个进程都不杀却照常返回。于是整条停止链路在「什么都没做」的情况下报告成功。

  该分支是 v4.2.0 引入的（服务经符号链 `mihomo-cli-service` 启动，需同时匹配符号链与真实二进制两种命令行），此前的 pattern 无分组，不受影响。

  除改用 ERE 的 `(a|b)` 外，还堵上了让它能潜伏下来的那个洞：`getMihomoPids` 现在只接受 `pgrep` 的退出码 0（有匹配）与 1（无匹配），其余一律报错——**探测失败不能再伪装成「没有进程」**。回归测试直接调用真实 `pgrep` 编译该 pattern，任何 JS-only 的正则语法都会被当场拦下。

## [4.2.0] - 2026-09-05

修两个「报告成功但其实没做到」的高危缺陷，均实测复现并回归验证。

### 修复

- **`start` 会把崩溃循环报成「已启动」**。内核因配置问题（端口占用、订阅里有内核不接受的字段）启动后立即退出时，`start` 打印「已启动 (PID xxx)」并退出 0，而 `KeepAlive` 正每隔约 10 秒把它反复拉起——用户以为代理开着，实际完全没有代理，日志被崩溃信息刷爆。更别扭的是几秒后 `status` 会显示「不在运行」，同一个状态两条命令给出相反答案。

  根因是 `launchctl bootstrap` 成功只代表**任务被装载**，不代表进程活着，而此前的实现固定 `sleep 500ms` 后取一次 pid 就认定成功。现在 `start` 会观察一个窗口确认内核稳定运行，失败则报错、退出码非 0，并直接附上日志尾部（TUN 路径本就 `tail -25`，服务路径此前什么都不给）。

  判据用 `last exit code` 而非 `runs`：`KeepAlive` 有约 10 秒重启节流，崩溃后 2 秒内 `runs` 仍是 1。实测还发现全新 `bootstrap` 后存在一段**假健康窗口**（`state = running` 且 pid 拿得到，进程其实马上要退出），长度不固定——同一台机器上量到过 180ms 与 540ms，故健康判定不能一看到 running 就收口。

- **服务模式下日志永不轮转**。`rotateAndCleanupLogs()` 只在 TUN 启动路径被调用，而 Mixed（默认模式）走 launchd，于是 `mihomo.log` 无限增长、`logs` 的归档列表恒为空——README 承诺的「自动轮转，保留 7 天」对默认模式根本不成立。唯一的兜底是日志超 10MB 时借重启做 copy-truncate。

  现在 `startService` 在 `bootout` 与 `bootstrap` 之间轮转日志。必须卡在这个窗口：运行中 rename 是无效的，launchd 的 `StandardOutPath` fd 指向旧 inode，改名后内核会继续往归档文件里写。

- **`status` 无法区分「用户主动停止」与「崩溃循环」**：两者都显示「不在运行」。现在检出内核上次非 0 退出时会额外提示，并给出排查与止损命令。

### 改进

- `help` 的说明列改为按最长命令签名自动对齐。此前靠手写空格，实测三段错位（控制组落在第 34 列、其余组第 30 列，`subscription add <url> [name]` 直接溢出）。对齐宽度按显示宽度计算，含中文占位符（`[编号]`、`[镜像]`、`[目标...]`）的签名不再少缩进
- 删除无消费者的死代码：`registerCleanup`/`runCleanup` 退出清理注册表（v4.1.0 移除 detached spawn 后已恒空转，留着会让人误以为信号安全网仍在生效）、`hasRootResidue`、`sleepSync`、`ProcessStatus` 的 `allProcesses`/`hasStaleProcesses`、`StartResult.alreadyRunning`、`downloadSubscription` 的 `persist` 参数
- 文档整理：`CLAUDE.md` 新增「报告成功前必须确认事情真的成立」一节收敛这类缺陷的共性，launchd 实测事实补录本轮四条新结论；`CODE_REVIEW.md` 从两轮历史修复清单（含已删除功能的条目）重写为当前基线的未处理项与已验证结论

## [4.1.0] - 2026-09-05

`daemon` 保活重构为 install/start/stop 服务模型，日常操作全程免密。

> ⚠️ **本版含破坏性变更**（`daemon` / `up` / `down` 命令移除、`start` 需先 `install`、`stop` 语义变化）。
> 版本号按次版本递增而非主版本，升级前请读下面这节。旧命令不会静默失效——执行时会给出明确的迁移指引。

### 破坏性变更

- **移除 `daemon` 命令**，保活从「可选增强」变为 **Mixed 模式的唯一运行方式**。命令族对齐 `install`/`start`/`stop`/`uninstall`：

  | 旧 | 新 |
  | --- | --- |
  | `mihomo daemon on` | `mihomo install`（一次）+ `mihomo start` |
  | `mihomo daemon off` | `mihomo stop` |
  | `mihomo daemon` | `mihomo status` |
  | — | `mihomo uninstall`（新增，彻底移除服务） |

  Mixed 模式不再有用户态直启路径（`startMixedMode` 的 detached spawn + pid 文件已删除），`mihomo start` 在服务未安装时报错引导 `mihomo install`。TUN 不变，仍是临时 sudo 进程。

- **默认改用用户级 LaunchAgent，`start`/`stop` 不再需要密码**。此前是 root LaunchDaemon（system 域），而该域的 `bootstrap`/`bootout`/`enable`/`disable` 一律需要 root——意味着每次启停都要输密码。

  推翻 v3.0.0 那条「必须用 root LaunchDaemon」的结论，依据是 Apple DTS 的原话：「Programs running as **root** are automatically granted local network access」——豁免条件是 root，不是「身为 daemon」。用户级 LaunchAgent 不豁免，但那只意味着走**正常的弹框授权流程**（首次连局域网节点时点一次「允许」，永久生效），并非被静默拦死。原先记录的「静默拦成 no route to host」是**无人登录、没人能点弹框**的服务器场景。

  **loopback 不算本地网络**：`127.0.0.1` 的 SOCKS 出口（如自建 `ssh -D`，v4.0.0 移除内置 ssh 后推荐的做法）完全不触发该机制。只有节点直接指向 `192.168.x.x` / `10.x.x.x` / `*.local` 时才会弹框。

  **升级须知**：老用户升级后，旧的 root LaunchDaemon 仍在。`mihomo install` 会检测到它并自动清理（需一次管理员密码，因为要删 root 拥有的文件），随后装上免密的用户级服务：

  ```bash
  mihomo install && mihomo start
  ```

  `status` 也会检出遗留安装并告警——不认它的话，它带的 KeepAlive 会持续拉起内核抢占端口，而用户态命令动不了它。

- **移除 `up` / `down` 别名**。命令名统一为 `install`/`start`/`stop`/`uninstall`。执行 `mihomo up`、`mihomo down`、`mihomo daemon` 会得到明确的迁移提示而非 did-you-mean 猜测（同 `--no-ssh` 的先例）。

- **`stop` 语义变更**：现在是「停止 **+ 关闭登录自启**」（`bootout` + `disable`），不再是单纯杀进程。只 bootout 的话 enable 位还在，下次登录代理会自己回来，而 CLI 已经报告「已停止」。

- **`reset` 的 `daemon` 目标改名 `service`**（`daemon` 保留为别名）。同时区分「停止」与「卸载」：`reset subs/data/runtime/kernel` 只 **stop** 服务（保留安装），只有 `reset service` 与 `--full` 才卸载。此前一律卸载，会让 `reset runtime` 顺手把用户的安装删掉。

- **配置变更后的重启条件收紧**：此前只要装了保活就恒重启（`isDaemonEnabled() || running`），现在改为仅在**确有实例在跑**时重启。服务已安装但已停止时执行 `sub use x` 不再把它启起来。

### 新增

- `mihomo install` / `mihomo uninstall`；`install` 会自动清理旧版本遗留的 root LaunchDaemon
- `status` 增加「服务」「自启」两行，并检出两类异常：plist 被手动删除但任务仍装载（KeepAlive 会持续拉起内核）、存在旧版本遗留的 root LaunchDaemon（抢占同一组端口）
- 服务以符号链 `kernel/mihomo-cli-service` 启动，「系统设置 → 通用 → 登录项与扩展」中显示为有意义的名字，而非一个没有上下文的 `mihomo`

### 修复

- **`bootstrap` 一个被 disable 的服务是硬失败**（`Bootstrap failed: 5: Input/output error`），不是「加载了但不启动」——本机实测。旧 `restartDaemon` 的 kickstart 回退分支在 bootstrap 前没有 `enable`，在新的 stop 恒置 disable 位的语义下会 100% 失败。install/start 的所有 bootstrap 前均已补 `enable`。
- **bootstrap 失败不再删除 plist**。旧 `enableDaemon` 失败时会 `rm -f plist` 回滚，在新语义下会把「重装」静默升级成「卸载」。现在失败后停在「已安装未装载」这个可恢复状态。
- **plist 被手动删除后的死胡同**：状态查询此前只看 plist 文件，文件不在就直接返回「未安装」，于是 `uninstall` 拒绝执行 `bootout`，而 KeepAlive 仍在拉起内核。现在 plist 不存在时也会探两个域的 launchctl，捞出孤儿任务（实测可复现，同 CODE_REVIEW #6）。
- 进程探测正则同时匹配真实二进制与符号链两种命令行——实测进程命令行记录的是**启动时用的路径**，服务经符号链启动，只认真实路径会漏掉它（残留杀不掉、状态误判）。

### 内部

- `daemon.ts` → `service.ts`，`DaemonStatus` → `ServiceStatus`（新增 `domain`/`installed`/`disabled` 字段），双域抽象 `DomainSpec`
- 状态查询改用 `launchctl print` / `print-disabled`（免 sudo，实测 3ms），取代此前 pgrep + root 属主过滤的近似判断，能拿到真实的 state/pid 与自启位
- `runtime.ts` 门面保留，双轨判据从「是否装了保活」改为「service 还是 tun」
- 新增 `service.spec.ts`（23 例）：`launchctl print` 输出解析（锁定行首单 tab 锚定，防嵌套 endpoint 的 `state = active` 污染）、`print-disabled` 解析（`enable` 同样会留下记录，不能只看是否在表中）、plist 生成、label 路径穿越校验
- `reset` 的裸执行保留清单抽为具名常量 `RESET_PRESERVED_ON_BARE` 并加测试锁定——此前是内联字符串数组，target id 改名时漏改会静默改变裸 `reset` 的行为

## [4.0.0] - 2026-09-05

移除 ssh 隧道功能。

### 破坏性变更

- **移除 `ssh` 命令及全部相关能力**。删除项：`mihomo ssh`（`add`/`up`/`down`/`status`/`rm`）、`start` 与 `stop` 的 `--no-ssh` 选项、`reset` 的 `ssh` 目标、settings 的 `ssh` 字段、数据目录的 `ssh/`。

  演进轨迹：v3.9.0 `tunnel` 统一为 `ssh` → v3.12.0 剥离配置层弱化为「只管端口」→ 本版整体移除。功能价值撑不起维护面——既要防 `--host` 的 `-oProxyCommand=` 注入、又要真实探测端口识别「假活」、还要维护 `started_by` 的 auto/manual 单向提升语义以免 `stop` 误杀，而它做的事等价于用户自己跑一条 `ssh -D 127.0.0.1:1080 -N host`。

  **升级须知**：自己起 `ssh -D`（可用 `~/.ssh/config` 的 `LocalForward` 或系统 launchd 托管），节点与分流规则照旧写在 `overwrite.yaml` 里，无需改动：

  ```yaml
  ~proxies:
    - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
  +rules:
    - DOMAIN-SUFFIX,example.internal,SSH-work
  ```

  老的 `settings.json` 里会留着 `ssh` 键、数据目录会留着 `ssh/` 与 `logs/ssh-*.log`。**不自动清理**：未知键本就被忽略，孤儿目录不影响任何行为，自动删用户数据的风险大于收益。想清干净就手动 `rm -rf ~/.mihomo-cli/ssh`。

### 内部

- 连带移除已无消费者的 `parseStringArg`（`--host`/`--port` 是仅有的两个调用方）与 `ResetTarget.onBefore` 钩子
- `readSettingsList` 泛型包装内联回 `getSubscriptions`（订阅是唯一剩余的列表字段）

## [3.12.1] - 2026-09-05

并发数据丢失与信号响应两处稳定性修复。

### 修复

- **订阅缓存并发写丢失**：`cache.json` 的读-改-写此前无跨进程保护（`settings.json` 早有 `withFileLock`，缓存被漏掉）。两个 CLI 进程同时写——一个终端 `sub update` 并行下载各自回写、另一个终端 `start` 又触发自动更新——后写者会整块覆盖先写者的条目，实测 4 进程各写 30 条丢 7 条。

  丢的是 `updated_at`，后果是该订阅 `needsAutoUpdate` 恒为 true、每次 `start` 都重新下载全量配置，且流量/到期展示一并消失。现在写入路径一律持锁，回归测试锁定（回退修复可稳定复现丢失）

- **`stop` 等待进程退出期间 Ctrl+C 无响应**：`cleanupAll` 用 `Atomics.wait` 忙等最多 5 秒、`stopSshTunnel` 最多 4 秒，其间事件循环被完全阻塞，SIGINT 要等轮询走完才被处理（实测 5.3 秒）。用户在 `mihomo stop` 卡住时按 Ctrl+C 会以为 CLI 挂死。改用 async 轮询后实测 102ms 响应

### 内部

- `cleanupAll` / `stop` / `stopSshTunnel` / `stopAutoSshTunnels` / `stopAllSshTunnels` 改为 async；`ResetTarget.onBefore` 放宽为 `() => void | Promise<void>`。`withFileLock` 内的同步忙等**保持不变**——持锁期间让出事件循环会让另一进程等到强夺陈旧锁
- 删除 `ConfigInfo.mode` 死字段（解析并声明，但无任何消费者）

## [3.12.0] - 2026-09-04

`ssh` 弱化为只管端口，配置层剥离；内部重构与命令合并，减少冗余。

### 破坏性变更

- **`ssh` 弱化为「只管端口」**：CLI 不再生成 `ssh.*.yaml`、不再合成 socks5 节点、不再往主配置里注入 ssh 层（`src/ssh-config.ts` 已删除）。`ssh` 现在只负责起停 `ssh -D 127.0.0.1:<端口>` 并真实探测端口死活；节点与分流规则改由你写进 `overwrite.yaml`，`ssh add` 会把可复制的片段打印出来

  **升级须知**：已有的 `ssh.*.yaml` 不再被加载，其中的分组与规则会失效。把内容搬进 `overwrite.yaml`，并补上此前由 CLI 注入的节点：

  ```yaml
  ~proxies:
    - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
  ```

  注意节点名不再有 `-Host` 后缀（`SSH-Work-Host` → 自己取名），端口以 `mihomo ssh` 显示的为准。副作用：`ow off` 现在会连带关掉 ssh 分流（此前刻意独立）；`ssh add` 不再自动重启；`reset ssh` 只删运行态，覆写文件归 `reset ow` 管

- **移除 `daemon status` 子命令**：与裸 `daemon` 输出完全相同，且顶层 `status` 已覆盖保活状态。查看状态用 `mihomo daemon`（无参）或 `mihomo status`
- **移除 `sub list` / `ssh list` 子命令**：裸 `sub` / `ssh` 即列表，与 `dir` / `ow` 同口径（v3.11.0 已删掉 `dir list` / `ow list`，此前一半命令能敲 `list` 一半不能）

### 修复

- **`start` 改为先校验配置、后停机**：坏订阅或坏覆写此前会在停掉运行中的内核**之后**才报错，留下「已停机 + 无 config.yaml」的半死状态且无从回滚。现在构建失败时运行中的代理原样保留
- **`logs` 透传 `tail` 的退出码**：日志文件不存在时此前恒退 0，脚本里 `mihomo logs 0 > out` 会把空结果当成功
- **`kernel` 拒绝未知选项**：`mihomo kernel --mirrror` 此前被静默忽略、按直连下载
- **`sub add` 拒绝以 `-` 开头的订阅名**：能建出但删不掉（`remove` 会把它当选项跳过）
- **`status` 的隧道行在无颜色环境下可读**：未运行的隧道此前只靠灰色区分，`NO_COLOR` 或管道输出时与运行中完全一样

### 变更

- **`log` 并入 `logs`**：`logs` 新增 `-f/--follow` 实时跟随；`log` 保留为隐藏别名（等价 `logs 0 -f`），不再在帮助中列出
- **拆分 `process.ts`（650 行）**为 `process-probe`/`process-start`/`process-stop`/`log-files`/`open`/`sudo` 六个职责单一的模块；`openUrl`/`getLogPath` 不再寄生在进程管理模块
- `runSudoScript` 收敛到 `sudo.ts`，TUN 启动与 launchd 保活共用同一套 sudo 脚本范式（各少一份手写 spawnSync/chmod/unlink 样板）
- `getSubscriptions`/`getSshTunnels` 收敛为 `readSettingsList` 通用读取 + 类型守卫
- 确认提示（`sub remove`/`ssh rm`/`reset`）收敛为 `shared.confirmOrThrow`，非 TTY 语义统一
- 流量展示抽成 `utils.formatTraffic`，`status` 与 `sub` 列表共用同一口径
- 修复 `status` 非保活模式下重复查询进程状态（`getStatus` 此前跑两遍）

## [3.11.0] - 2026-09-04

命令与机制瘦身：删掉冗余快捷命令和已完成历史使命的迁移引导。

### 破坏性变更

**不提供兼容别名，删掉的命令直接报「未知命令」。**

- **移除冗余快捷命令**：
  - 顶层 `use`（用 `sub use`）、`on`/`off`（用 `ow on`/`ow off`）、`open`（用 `dir open`）
  - `update` 的别名 `upd`/`upgrade`
  - `dir list`（与裸 `dir` 输出完全相同）、`ow list`（与裸 `ow` 输出相同）
  - `logs current`（用 `logs 0`）
- **移除 v3.10.0 已删功能的迁移引导**：顶层 `test`/`clean`、`sub test`/`sub clean`、`start -r/-t/-j/--no-clean` 不再有专门的报错引导，统一走「未知命令/未知选项」处理。这些功能已删除一个版本，引导文案完成使命

### 变更

- 修复 README 中对已删功能的引用（`sub web`、`start -r/-t/-j`）
- 清理注释中对已删 `clean` 命令的引用

## [3.10.0] - 2026-09-04

一次功能瘦身：删掉三块「内核或 Web UI 已经做得更好、或维护成本高于价值」的功能，减少约 900 行代码。

### 破坏性变更

**不提供兼容别名，删掉的命令直接报「未知命令」。**

- **移除节点测速与清理**：`test`、`clean`、`sub test`、`sub clean` 四个命令，以及 `start` 启动后的自动测速清理

  替代：`mihomo ui` 打开的 Web 面板（zash / metacubexd / yacd）都内置逐节点实时测延迟，交互远好过终端进度条；要自动选路则在订阅里用 `url-test` 分组，由内核持续测速——两者都比 CLI 的一次性快照更实时。

  移除的理由不止是重复：`clean` 会依据一次测速结果**永久改写磁盘上的订阅 YAML 删节点**，而测速失败常来自本地网络抖动、机场限速或被默认 100 并发打到风控，误删只能靠重下订阅恢复。`start` 里的自动清理更是隐式触发（节点数 > 100，GitHub 源 > 50），让一条 `mihomo start` 可能卡上几十秒、删掉节点、再重启一次内核。

  连带移除：`-t/--timeout`、`-j/--concurrency`、`-r/--rounds`、`--no-clean` 选项，隔离测速实例（含其占用的 27890/29090 端口），以及订阅缓存里的 `last_auto_clean_at` 字段（残留在 cache.json 里无害，会被忽略）。

- **移除多源合并订阅**：`sub add` 不再接受逗号分隔的多个 URL

  已存在的多源订阅**会更新失败**（整串被当作单条 URL 请求）。请 `mihomo sub remove` 后按单条 URL 重新添加，多个来源改为添加多条订阅、用 `sub use` 切换。

  该功能本身只有约 70 行，但「逗号是切分符还是 URL 的合法字符」这个判据需要在三处保持同步（`maskUrl`、`isMultiUrl`/`splitUrls`、`overwrite.splitUrlsLocal`），任一处走样就会漏遮蔽 token 或让合法订阅加不进来——历史上两种都发生过。维护成本远高于代码量。

- **移除 `kernel --mirror-all`**：GitHub API 现在**恒直连**，`--mirror` 只作用于产物下载

  `--mirror-all` 让镜像同时接管 API，于是 `browser_download_url` 完全由镜像说了算，而 `withMirror` 对非 GitHub 地址原样放行——镜像只要返回指向自己的地址，就能让 CLI 下载任意二进制。该产物随后 `chmod 755` 并在 TUN / 保活模式下**以 root 运行**。上游 release 不提供 checksums，把来源钉死是主要防线，不能自己拆掉。API 访问受限时请用系统代理，而不是让镜像决定下载什么。

### 变更

- `maskUrl` 不再按逗号切分，整条 URL 一次处理。逗号在 query 中合法，切开会让 `?nodes=us,hk&token=xxx` 的 token 参数识别不出而明文输出——实测新行为在各类含逗号的输入上均不泄漏
- 删除 `src/test-instance.ts`、`src/progress.ts`、`src/commands/test.ts`
- 删除死代码 `normalizeProxyNamesBeforeSave`（裁剪节点名里的 `_github.com/<repo>` 尾缀）：它只被 `clean` 的保存路径调用，随之失去入口
- `start` 保留的选项：`-s`/`--no-update`、`-u`/`--update-timeout`、`--no-ssh`

### 顺带清理

同一轮里删掉的小块功能，都属于「有更好的现成替代，或与文档重复」：

- **`sub web`**（打开机场页面）：依赖机场返回 `profile-web-page-url` 响应头，缓存里没有时还要**额外发一次订阅请求**只为读这个头。浏览器书签更直接。订阅列表里仍会展示机场下发的页面地址，只是不再代为打开
- **`logs` 的按文件名/子串查找**：归档名是 `mihomo.<时间戳>.log`，没人会去敲；而支持子串匹配就得额外防路径穿越。现在只认 `0`/`current` 与列表序号，非法编号显式报错
- **`dir list` 的硬编码目录树说明**：29 行 `console.log` 与 README 的「数据目录」章节重复且易失同步，改为从 `DIRECTORY_TARGETS` 生成
- **死代码 `requireRunning`**：唯一调用方是本轮删掉的 `test`/`clean`

## [3.9.1] - 2026-09-01

### 变更

- **注入的节点/分组名改为 `SSH-<名字>` / `SSH-<名字>-Host`**（原 `Ssh-<名字>`）：`SSH` 是协议缩写应全大写，隧道名首字母大写，如 `ssh add byted` 生成 `SSH-Byted`。已生成的 `ssh.*.yaml` 里写的是旧名，需把分组名与规则里的 `Ssh-` 改成新形态（或删掉该文件让 `ssh up` 重新生成，但会丢掉手写的分流规则）

## [3.9.0] - 2026-09-01

ssh 隧道功能的一次结构整理：命令名统一，配置文件脱离覆写机制，顺带修掉一个静默失效的端口漂移 bug。

### 破坏性变更

**不提供任何迁移与兼容代码**，升级前请先 `mihomo stop`（或 `mihomo tunnel down` 停掉隧道），再手工处理：

- **命令 `tunnel` 改为 `ssh`**，`tunnel`/`tunnels` 别名一并删除，`--no-tunnel` 选项改为 `--no-ssh`。`reset` 目标同样只认 `ssh`
- **`settings.json` 的 `tunnels` 字段改为 `ssh`**，不迁移、不读取。旧字段会残留在文件里但永不生效，**隧道需重新 `mihomo ssh add`**
- **配置文件 `overwrite.tunnel-<名字>.yaml` 改为 `ssh.<名字>.yaml`**，且其中**不再需要（也不应该）声明 socks5 节点**——节点已由 CLI 内建注入。迁移时把分流规则挪到新文件、把分组名从 `Tunnel-<名字>` 改为 `SSH-<名字>`，然后**删掉旧文件**：它仍匹配 `overwrite.*.yaml`，留着会被覆写机制继续加载并注入一份重复节点
- **隧道运行态目录从 `tunnel/` 迁至 `ssh/`**。升级前未停的隧道进程会失联——旧目录里的 PID 不再被读取，那些 `ssh -D` 进程会继续占着端口而 CLI 无路径可停，需手工 `pkill -f 'ssh -D'` 清理，旧目录可直接删除

### 修复

- **改端口后静默失效（隐性数据 bug）** - 隧道有两份真相：`settings.json` 里的 host/port，和用户维护的覆写文件里手写的 socks5 节点。CLI 只写前者。于是 `tunnel rm work` 后再 `tunnel add work --port 1081`，因覆写文件已存在而不重建，配置里的节点仍指向 1080——隧道监听在新端口，mihomo 往旧端口送流量，**全程无任何提示**

  修法是取消「节点写在用户文件里」这个前提：节点改由 CLI 依据 settings 合成注入，端口从此只有一个真相。`ssh add` 现在也恒触发重启（此前只在新建模板时重启，改端口那次正好漏掉）

- **`ow off` 会连带断掉内网分流** - 覆写是可选调优，内网出口是刚需，前者关掉不该让后者失效。此前隧道节点住在覆写文件里，`ow off` 会让它们整批从配置里消失，而 ssh 进程照常跑着，无任何提示。现在 ssh 配置走独立管线，不看覆写开关

- **同名节点冲突时用户文件可覆盖安全约束** - `~proxies` 是字段级合并且后合并者胜，此前字母序更靠后的覆写文件能改掉隧道节点的 `server`/`port`（`docs/ssh-requirement.md` 的「实现记录 2」已记载该局限）。现在 CLI 注入恒排在所有用户文件之后，手写同名节点改不掉端口，也绕不过 `127.0.0.1` 绑定

- **`reset --full` 会留下 ssh 配置文件** - 新的 `ssh.*.yaml` 既不归 `overwrites` 目标管，旧 ssh 目标又只删运行态，「删全部」名不副实。现 `reset ssh` / `reset --full` 一并删除；单条 `ssh rm` 仍保留该文件（里面有用户手写的分流规则）

### 变更

- `src/tunnel.ts` 拆为 `src/ssh.ts`（进程侧）与 `src/ssh-config.ts`（配置侧）。拆分是硬性要求：`config.ts` 需调用配置侧，而进程侧依赖 `process.ts`、后者又依赖 `config.ts`，不拆就是循环依赖
- 隧道列表读取 `getSshTunnels` 下沉到 `settings.ts`，与 `getSubscriptions` 对齐
- 新增分阶段调试文件 `runtime/4.ssh.yaml`（ssh 层的合并输入，含 CLI 注入的节点）。不并入 `2.overwrite.yaml`——那会让 `ow off` 时的调试输出自相矛盾
- 日志文件 `logs/tunnel-<名字>.log` 改为 `logs/ssh-<名字>.log`
- `ssh` 列表现在显示每条隧道的配置文件路径

### 测试

- 单测 165 → 185：新增 `ssh-config.spec.ts` 20 项，覆盖合并层序（含「用户手写同名节点改不掉 port/server」这条核心不变量）、`ssh.*.yaml` 与 `overwrite.*.yaml` 的双向文件名隔离、注入节点的 include-all 整名锚定排除

## [3.8.1] - 2026-09-01

一轮全量代码审查的修复集：1 项新发现的高危数据丢失，以及上轮审查遗留的 9 项「仍待处理」。全部经实际复现确认，修复后回归验证。

### 修复

- **并发操作会静默丢数据（高危）** - `settings.json` 无跨进程锁，两个 CLI 进程各自读旧全量再写回，后写者把先写者的改动整块抹掉，**而先写者已经打印了「已添加」**。实测 6 个并发 `sub add` 丢 3 条；慢速 `sub add`（跨网络下载）期间执行 `tunnel add`，隧道被抹成 `null`——订阅与隧道同住一个文件，互不相干的命令互相摧毁。触发条件很日常：机场慢时 `sub add` 要跑十几秒，此间在另一个终端做点别的即可

  修法是新增文件锁（`O_EXCL`）把整个「读-改-写」圈起来。仅「写前重读盘」不够——读与写之间仍有窗口，实测仍丢 3 条。持锁超过 10s 视为进程已崩溃并强夺，避免一次崩溃永久锁死后续所有命令

- **内核下载来源未钉死（供应链）** - `--mirror-all` 下连 GitHub API 都走镜像，`browser_download_url` 完全由镜像说了算，而此前对非 github 的 URL 原样放行，镜像返回任意主机地址即可让 CLI 下载任意二进制；该产物随后 `chmod 755` 并在 TUN/daemon 下**以 root 运行**。现加下载 host 白名单 + 强制 https（校验在加镜像前缀之前），curl 补 `--proto '=https' --proto-redir '=https'`（实测 `-L` 会跟着 302 降级到明文 http 并落盘）与 `--max-filesize`，下载后比对 `asset.size`

- **归档 symlink 成员可 chmod 任意文件** - 名为 `mihomo`、指向任意路径的符号链接，其条目名完全合法（不含 `..`、非绝对路径），能通过路径穿越守卫，随后被当成二进制 `chmod 755`——实测把 `chmod 600` 的文件改成了 755。现同时校验条目**类型**（拒符号/硬链接）并把遍历的 `statSync` 改为 `lstatSync`

- **畸形流量响应头会抹掉已有用量数据** - `Subscription-Userinfo` 返回 `garbage` 这类无有效字段的头时，解析结果 `{}` 是 truthy，导致 upload/download/total/expire 四个字段被 `undefined` 覆盖。反直觉的是**没有响应头反而安全**（整块跳过）。另修 `expire=abc` 被塞 0 而显示成「永久有效」（垃圾值朝最误导的方向失败）、`total=1e999` 写成 `null`、负数原样入库使百分比失真

- **时钟偏移导致订阅永不自动更新** - `updated_at` 落在未来（系统时间被改过、跨时区调时）时时间差恒为负，`needsAutoUpdate` 恒 false，订阅静默过期到失联

- **`daemon off` 在 plist 被手动删除后是空操作** - 用户 `sudo rm` 掉 plist 后任务仍处装载状态，此前只看文件存在就直接返回，永不执行 `launchctl bootout`，于是 KeepAlive 继续把内核拉起——杀掉立刻重生，且 CLI 无任何途径卸载。现判据改为「plist 不在**且**无 root 内核在跑」

- **`daemon on` 遗留 root 属主 pid 文件** - 使后续 `daemon off` → `start` 撞上残留检查而拒绝启动，这个死胡同完全由 CLI 自身的 on/off 循环造成

- **热重载信任 9090 上的任意响应** - 该端口被其他服务占用且对 PUT 返回 2xx 时，CLI 打印「已重启 (保活)」而 daemon 内核仍跑旧配置，配置变更静默未生效。现先确认应答方确为 mihomo

- **`tunnel up` 期间 Ctrl+C 泄漏 ssh 进程** - 等待转发建立最长 20 秒，其间中断会留下孤儿 ssh 进程和一份声称健康的运行态文件（实测持久残留、不自愈），随后 `tunnel up` 报「已在运行」而 `status` 报「假活」，自相矛盾。现在该窗口内注册一次性清理，启动成功后立即注销以保持「隧道活过 CLI 退出」的语义

- **`__proto__` 作订阅名时缓存永远写不进** - 该名称通过校验，但在普通对象上赋值是设置原型而非自有属性，落盘为 `{}`，`updated_at` 永远缺失 → 每次 `start` 都重新下载该订阅

- **配置校验的四个静默空洞** - 均无任何告警：proxy 与 proxy-group 同名（两者都留下，mihomo 因重复名拒绝加载）；`use` 引用不存在的 provider（从不校验，且使该组免于删除）；节点池为空 + `include-all` 的空组保留（实际无任何出口）；`proxies` 写成字符串时整体跳过校验、非法结构原样落盘

- **`--mirror` 接受非法 scheme** - 此前用 `startsWith('http')` 判断，放行 `httpfoo://x` 与明文 `http://`，并把 `ftp://e.test` 拼成 `https://ftp://e.test/`。现改用 `URL` 解析 + https 白名单

- **sudo 中间脚本的权限位不重放** - `writeFileSync` 的 `mode` 只在创建新文件时生效，前次崩溃残留的同名文件会保留旧权限（实测 0666 重写后仍是 0666），而该文件下一步就交给 sudo 执行。两处写后补显式 `chmodSync`

### 测试

- 单测 145 → 165：文件锁 6 项（含用真实子进程验证跨进程互斥、陈旧锁强夺、异常路径释放）、`parseUserInfo` 边界 8 项、配置校验空洞 6 项（含「正常配置不产生告警」的回归用例）

## [3.8.0] - 2026-09-01

### 新增

- **ssh 隧道出口（`tunnel` 子命令，别名 `ssh`）** - 管理 `ssh -D` 动态转发进程的生命周期，把可 ssh 登录的机器变成本地 SOCKS5 出口。分流仍交给覆写机制，本功能补的是「隧道断了 mihomo 不知情、会一直往死端口送流量」这一环

  ```bash
  mihomo tunnel add work --host m4 --port 1080
  mihomo tunnel up|down|status [名字]
  mihomo tunnel rm <名字>
  ```

  - **随 `start` 一并拉起**：默认带 `auto` 标记，`start` 顺带启动、`stop` 连带停止（`--no-tunnel` 跳过，`add --no-auto` 不参与）
  - **隧道失败不影响内核启动**：只影响内网分流那部分规则，故仅打印显眼的黄色警告并附上 ssh 给出的原因，其余流量照常
  - **`stop` 只停自己起的**：手动 `tunnel up` 起的隧道带 `manual` 标记，不会被 `mihomo stop` 带走，避免下次 start 又起一个而累积僵尸进程
  - **`status` 真实探测端口**：能识别「进程还在但转发已死」的假活——那正是最误导的形态，此时 mihomo 仍在往死端口送流量
  - **起之前先检测端口占用**，不盲启后失败
  - **`add` 生成覆写模板** `overwrite.tunnel-<名字>.yaml`（已建好 socks5 节点与 select 分组，分流规则留白待填），生成后完全由用户维护，CLI 不再改写，`tunnel rm` 也不删它
  - 新增 `reset tunnel` 目标（先停进程再删运行态，反序会导致 ssh 进程失联且再也停不掉）

  安全边界：`-D` 恒绑 `127.0.0.1` 且不提供绑定地址开关（绑 `0.0.0.0` 会让同一 WiFi 下任何设备经本机进内网）；`--host` 拒绝 `-` 开头的值（`-oProxyCommand=...` 等同任意命令执行）；ssh 参数固定带 `ExitOnForwardFailure`/`BatchMode`/`ConnectTimeout`/`ServerAlive*`

  暂不做自动重连保活：断线依靠 `ServerAliveInterval` 让进程自退，再用 `tunnel status` 查出来

### 修复

- **`reset --full` 会留下空的 `settings.json`** - 新增的 `tunnel` 目标其 `onAfter` 会 `writeSettings` 清空隧道列表，若排在 `settings` 之后就会把刚删掉的文件重建成 `{}`，与「已重置: 设置」矛盾。现移到 `settings` 之前（与 `subs` 同理），并加单测锁定该顺序约束——这是 v3.7.0 已修过一次的同类问题（当时是参数顺序），换个目标又复发了

## [3.7.0] - 2026-08-22

### 修复

- **错误响应体绕过大小上限，可致 OOM** - `!response.ok` 分支直接 `await response.json()`，不经流式大小检查。实测 60MB 错误体使客户端 RSS 增长 303MB——攻击者只需返回非 2xx 即可绕过 50MB 防护。现错误体限量 64KB 读取（仅用于诊断），修后 RSS 增长 9MB
- **机场返回错误 JSON 会覆盖磁盘上可用的订阅** - 下载后只要内容能解析成对象就原子覆盖写盘。机场返回 `{"error":"quota exceeded"}` 之类响应时报「已更新 (0 节点)」，把原本可用的订阅**不可恢复地覆盖**，随后 mihomo 带零节点启动导致断网；且这在 `start` 的自动更新路径上，用户无操作即触发。现写盘前要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空，并提取服务端错误信息作为提示
- **`ps` 输出截断致测速实例泄漏并占用端口** - `isProcessCommandMatching` 未带 `-ww`，BSD/macOS 的 `ps` 即使 stdout 非终端也把 command 列截断到 79 列。测速实例的匹配串（`test/runtime/config.yaml`）起始偏移随用户名增长（`alice` 为 80、`jonathan.smith` 为 98），常见家目录下均越界 → 匹配恒失败 → `stopTestInstance` 跳过 SIGKILL 却仍删 pid 文件，内核残留占着 27890/29090 且再无记录，下次 `sub test` 直接启动失败
- **`sub add` 失败时劫持当前活跃订阅** - `setDefaultSubscription` 在下载之前执行，回滚时 `removeSubscription` 把活跃订阅落到列表首项而非用户原选择。复现：活跃为 `work`、列表为 `[airport-a, work]`，添加一个不可达 URL 失败后活跃变成 `airport-a`，下次 `start` 静默连错机场。现切换移到下载成功之后
- **`MIHOMO_CLI_DAEMON_LABEL` 未校验导致 root 任意路径写** - 该值经 `path.join` 拼成 plist 路径后，是 `sudo install -m 644 -o root` 的写入目标与 `sudo rm -f` 的删除目标，而 `path.join` 会折叠 `..`（`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），内容还部分可控。现加字符集校验：非法值回退默认标签，并在 `enableDaemon`/`disableDaemon` 入口报错
- **覆写注入节点的 `exclude-filter` 误排除同前缀节点** - mihomo 的 `exclude-filter` 是无锚点正则搜索。注入名为 `HK` 的节点后，订阅里的 `HK-01`/`HK-02` 全被踢出 `include-all` 分组。现改为 `^(?:...)$` 整名锚定
- **覆写 YAML 笔误抛裸 `TypeError` 并打印堆栈** - `validateConfig` 的类型断言无校验，四种常见笔误会崩溃：`proxies` 含空列表项、`rules` 漏写 `-` 成标量、`proxy-groups` 写成映射、`rules` 含非字符串。用户配置错误被当成程序 bug。现全部转为带修正提示的 `CliError`
- **`~key`/`+key` 作用于非数组时静默损坏配置** - 静默包成单元素数组：`~dns: {enable: true}` 把映射 `dns` 变成 `[{enable: true}]` 并丢掉原有字段，而 mihomo 要求 `dns` 是映射；`log-level+: debug` → `["debug"]` 同理。现报错并提示改用 `key!` 或直接写 `key`；目标不存在时仍放行（新增数组的正常用法）
- **`maskUrl` 逗号切分致 token 明文泄漏** - 无条件按逗号切分，`?nodes=us,hk&token=SECRET` 被劈开后两段都识别不出 token 参数，密钥明文输出。同一根因还让 query 含逗号的合法单 URL（`?flag=clash,meta`）被误判多源、`sub add` 报「无效的 URL」而无法添加。现统一判据为「切分后每段都是合法 http(s) URL 且不止一段」
- **`settings.json` 为合法 JSON 但非对象时绕过损坏恢复** - `null`/`[]`/`123`/`"hi"` 都直接进缓存，不备份不告警：`null` 让 `getSubscriptions()` 抛裸 `TypeError` 且缓存判定恒失效，字符串被展开成 `{"0":"h","1":"i",...}`。现一并走备份+回退分支
- **`subscriptions` 非数组时被按字符展开** - 手改成 `"oops"` 后 `addSubscription` 写出 `["o","o","p","s",{...}]` 且不报错。现在唯一读取入口 `getSubscriptions()` 收口校验，并滤掉缺 name/url 的残缺条目
- **`reset` 忽略停止进程的结果** - root 实例（TUN）下走 `sudo pkill`，用户取消密码时失败的 pid 被静默丢弃，仍继续删除数据，留下孤儿 root 进程跑在已删配置上。现删数据前复查并中止
- **`reset --full` 残留含密钥的备份文件** - `settings.json.bak`（损坏恢复时生成）带 `controller_secret` 与订阅 token 明文留下，与「已重置: 设置」矛盾。现纳入删除路径
- **`reset` 结果依赖参数顺序** - `subs` 目标的后置钩子会重建 `settings.json`，故 `reset settings subs` 留下 `{}` 而 `reset subs settings` 才真删。现按注册表顺序执行
- **`match` 的订阅名匹配与 `sub use` 口径不一致** - `sub use home` 能切到订阅 `Home`（模糊匹配大小写不敏感），但 `match: {subscription: home}` 精确比对匹配不上。现统一为大小写不敏感
- **`parseIntArg` 接受危险值** - 无范围校验：`-j 0` 让测速起 0 个 worker、结果全空洞、被报成「所有节点失败」（伪造结果）；`-t 5s` 静默取 5ms 让全部节点超时。现非正整数一律报错，并把 `test`/`clean` 的参数校验移到运行状态检查之前
- **合并订阅的错误指向被连带取消的 URL** - 任一 URL 失败即中断其余请求，按顺序取第一个错误报出的往往是被取消的那条，真正的 403/token 过期被隐藏。现优先报非取消类错误
- **`dir` 子命令的错误绕过统一渲染** - `cmdDirectory` 用 `void` 丢弃 async 分发的 Promise，`dir open <未知目标>` 抛的错误退化成「未处理的 Promise 拒绝」，丢掉标签颜色与可用目标列表
- **`ow`/`dir` 未知子命令静默回落** - `ow onn` 静默打印列表且退出码 0（对比 `sub adz` 会报错并给纠错建议）。现补齐纠错提示
- **测速实例的 pid 记录时机存在泄漏窗口** - spawn 与写 pid 文件之间被 Ctrl+C 中断时，只认 pid 文件的清理逻辑会漏掉 detached 子进程。现增加内存记录作为第二来源
- **`reset` 保活取消路径退出码为 0** - `console.error` + `return` 使「重置中止」被脚本误判成功，且绕过统一渲染
- **`mihomo on`/`off` 丢弃启动选项** - 唯二不透传后续参数的快捷命令，`mihomo on -s` 静默吞掉 `-s`，而 README 声明其与 `ow on` 等价
- **`restartDaemon` 抛裸 `Error`** - 最后一处未迁移的数据层预期错误

### 新增

- **平台守卫** - `package.json` 声明 `"os": ["darwin"]`，`main()` 开头校验平台（豁免 `help`/`version`，`MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 为开发逃生阀）。此前非 macOS 上是「部分成功」：`status`/`sub` 看着正常，`daemon on` 输完 root 密码才撞 `/Library/LaunchDaemons`，`ui` 报告成功却什么都没打开（`open` 命令缺失被吞掉，且 Debian 的 `open` 指向 `run-mailcap` 会把 URL 当附件处理）。守卫先于目录创建，避免在不支持的平台留下数据目录
- **`sub remove` 模糊匹配需确认** - 精确名称直接删除；模糊命中时展示完整名称并要求确认（`-y`/`--yes` 跳过）。此前 `sub remove air` 会无提示删掉 `production-airport`
- **`subs` 别名** - 与 `directory` 的 `dirs` 对称，落地命名规范的「简写复数」档
- **GitHub Actions CI** - 在 `macos-latest` 上跑 typecheck / lint / test / build
- **`prepublishOnly` 钩子** - `dist/` 被 gitignore 且此前无发布钩子，漏跑构建即发布陈旧或缺失产物

### 变更

- **破坏性操作在非交互环境报错而非静默取消** - `reset`（无 `-y`）与 `sub remove`（模糊匹配）在管道/CI 下此前打印「已取消」并退出 0，脚本会误判操作已完成。现报错退出 1 并提示加 `-y` 或用完整名称
- **`confirmPrompt` 收敛到 `commands/shared.ts`** 并增加 TTY 守卫（此前在非交互环境会挂住等输入）

### 内部

- **单测从 55 增至 101** - 新增覆盖：配置形态校验、`exclude-filter` 锚定、覆写数组语义误用、`match` 大小写、`parseIntArg` 边界、多源 URL 逗号判据
- **`CODE_REVIEW.md` 重写** - 上一轮（v2.9.x 基线）的「仍待处理」清单已逐项复核：#12/#14 实际已修复，#10 的后果比原描述严重（是 token 泄漏而非仅显示切碎），#17 的建议不可行——上游 v1.19.30 的 127 个资产中零 checksum 文件，故真实缺口是下载地址的 host 未钉死。新增 9 项待处理（tar symlink 致任意文件 chmod 755、热重载信任任意 9090 响应、`Subscription-Userinfo` 边界等）
- **`README.md` / `CLAUDE.md` 校正** - 平台说明从「Windows / Linux 正在适配中」改为「仅支持 macOS」（此前无对应代码）；覆写实为默认启用（此前文档教用户先 `ow on`）；`log -o` 是系统默认程序而非编辑器；补齐 `logs current`、长选项、`reset`/`dir open` 完整目标列表、分阶段调试文件；新增「选项写法」「数据保护」两节

## [3.6.0] - 2026-08-15

### 修复

- **`sub add` 重名时误删既有同名订阅** - 回滚逻辑包住了入库步骤，添加重名订阅时「已存在」错误同样触发 `removeSubscription`，把用户既有的同名订阅（含缓存与配置文件）删掉。现入库移出 try 块，回滚仅覆盖「入库成功后下载失败」
- **`start` 拼错模式名静默按 Mixed 启动** - `mihomo start tn` 之类只判 `=== 'tun'`，拼错不报错，用户会误以为已切到 TUN。现校验模式参数并报错，参数校验先于内核/订阅环境检查
- **pidFile 运行判定可被 PID 复用欺骗** - 只检查 pid 存活，系统重启后残留 pid 文件里的 pid 可能已被无关进程复用，被误判成运行中的 mihomo。现同时校验进程命令行包含内核路径（与测速实例防护同口径）
- **数据层预期错误打印堆栈** - 订阅名称非法/重名、未找到订阅配置、无有效节点、内核/配置缺失等用户可见的预期错误仍抛裸 `Error`，经统一收口后打印堆栈。现全部迁移为 `CliError`

### 新增

- **did-you-mean 纠错** - 未知命令与 `sub`/`daemon` 未知子命令按前缀 + 编辑距离给出纠错建议（如 `mihomo strt` -> `是否想输入: start / stop?`）
- **`update` 更新前检查最新版** - 先查 npm registry，已是最新版本则跳过重装；查询失败（15s 超时）降级为直接安装
- **`status` 显示订阅流量与到期** - 复用订阅缓存的响应头数据，有则展示
- **场景化提醒** - `ui` 在 mihomo 未运行时提示先启动；`kernel` 更新成功后运行中实例提示需重启生效

### 内部

- **utils 按职责拆分** - `colors.ts`（颜色）、`errors.ts`（CliError/TimeoutError/withTimeout）、`http.ts`（HTTP 客户端）独立成模块；`isProcess*` 进程探测归入 `process.ts`，`isProxyValid` 归入其唯一消费者 `test-instance.ts`；`VERSION`/`PKG_NAME` 移入 `constants.ts`。`utils.ts` 只留无副作用的纯函数（sleep、转义、格式化、flag 解析、纠错建议）
- **补充单元测试** - 新增 `suggestSimilar`（did-you-mean）单测，总计 55 个

## [3.5.0] - 2026-08-15

### 变更

- **统一错误处理机制** - 命令层与数据层的预期错误改为抛出领域错误 `CliError`，由入口 `main().catch` 单点渲染（错误前缀 + 多行提示 + 退出码）并执行清理。此前命令层散落几十处 `console.error + process.exit`，错误从不冒泡到统一收口、可能绕过退出前清理。现仅信号处理器与日志 `tail` 事件回调保留直接退出（进程生命周期末端，无法收口）。所有错误前缀统一为红色（`NO_COLOR`/非 TTY 下自动降级为纯文本），动词化提示（如「配置错误」「启用保活失败」）予以保留
- **数据层去除 UI 副作用** - `pickSingleSubscription` 等数据层函数不再直接打印和退出进程，改为抛错由命令层收口，函数返回类型恢复诚实、可复用

### 内部

- **命令子命令分发同构化** - `subscription`/`overwrite`/`directory`/`daemon` 的手写 `if (action === ...)` 分支链改为与顶层命令注册表同构的表驱动分发（`dispatchSubcommand` + 子命令表），并抽取 `requireRunning`/`restartToApply`/`requireActiveSubscription`/`resolveSubscription` 等公共 helper 消除重复。命令行为、帮助输出与退出码均无变化
- **补充单元测试** - 为覆写合并（`parseOverrideKey`/`deepMergeWithOverrides`/作用域匹配）、配置校验（级联删除/规则目标）、节点名归一化、URL 遮蔽等高危纯函数补充 49 个单测，使用 Node 内置 `node:test` 经 tsx 运行，零新增依赖（`npm test`）

## [3.4.0] - 2026-08-15

### 修复

- **配置 `controller_secret` 后测速与热重载失效** - 访问 external-controller 的 HTTP 客户端从不发送 `Authorization`，设置密钥后 `test`/`clean`（走主实例）所有节点返回 401 被判失败，保活的配置热重载也恒 401 回退到 sudo 重启。现测速（主实例）与热重载请求均携带 `Bearer <secret>`；隔离测速实例自身无密钥，不受影响
- **并行更新订阅时缓存临时文件互相踩踏** - `atomicWriteFileSync` 的临时文件名仅含 pid，同进程 `Promise.all` 并行更新多个订阅时写向同名临时文件，导致内容交错或 `rename` 失败。临时名改为 pid + 进程内自增序号，各写入落到独立临时文件

### 安全

- **YAML 别名炸弹 DoS 防护（回归修复）** - 解析订阅/覆写/运行时配置的 `yaml.load` 未设别名上限，js-yaml 默认无限制，恶意配置可借指数级别名膨胀耗尽内存/CPU。现统一设 `maxAliases` 上限
- **序列化对歧义标量加引号** - 配置序列化改用会给 `on`/`off`/`yes`/`no` 等歧义标量加引号的默认 schema。此前裸输出的 `name: on` 虽被 mihomo（go-yaml v3）读作字符串，但流经 PyYAML 等 YAML 1.1 工具会被误解析为布尔，造成静默的配置损坏
- **内核下载文件名路径穿越防护** - 下载内核时临时路径直接拼接 GitHub API 返回的 asset 名，被篡改的响应/镜像可借 `../` 写出内核目录之外。现用 `basename` 剥离目录成分
- **`open` 命令 URL 参数注入防护** - 打开订阅页面/日志文件时，服务器可控的 URL（订阅响应头 `web_page_url`）若以 `-` 开头会被 `open` 当作选项。现加 `--` 终止选项解析
- **测速实例终止前校验进程身份** - 停止隔离测速实例时按 pid 文件裸值 `SIGKILL`，pid 被系统复用后可能误杀无关进程。现杀进程前校验其命令行确属该测速实例

### 变更

- **覆写 `~proxies` 注入的节点纳入 include-all 排除** - `~key` 就地合并在同名节点不存在时会追加新节点，此前只有 `+proxies`/`proxies+` 注入的节点会从 `include-all` 分组排除，`~proxies` 追加的节点会被重复纳入。现一并排除
- **依赖升级** - `js-yaml` 5.2.1 → 5.3.0（修复 flow collections 指数解析 DoS）、`esbuild` 经 overrides 提升至 0.28.2（修复 dev server 任意文件读取）、`@types/node` → 26、`@biomejs/biome` → 2.5.8、`lint-staged`/`tsx` 跟随最新；`npm audit` 无告警

## [3.3.0] - 2026-08-15

### 新增

- **覆写按 name 就地 patch 数组元素（`~key` 语法）** - 此前覆写数组只有整体替换（`key!`）、前置（`+key`）、追加（`key+`）三种语义，无法「只改数组里某一个元素的部分字段」。新增 `~key`：以 `name` 为主键匹配数组元素，命中则深度合并该元素、保留其余字段与其余元素，找不到则追加。典型用途：修改订阅下发的某个 `proxy-group` 的字段（如给 `select` 组注入 `default-selected` 改默认选中节点），保留原有全部节点、不动其它分组、订阅更新后依然生效。键名真以 `~` 开头时用 `<~key>` 转义
- **覆写作用域限定（`match` 块）** - 覆写文件顶部可加 `match:` 块，让该文件只对指定订阅生效（无 `match` 仍全局生效，向后兼容）。支持 `subscription`（按订阅名精确匹配）和 `url-domain`（按订阅 URL hostname 后缀匹配）两个条件，所列条件需全部满足（AND），条件值为数组时其内部为 OR。未知匹配键或无法评估的条件均 fail closed（跳过该文件并告警），避免误配置静默全局生效。`ow list` 与 `status` 会展示各文件的作用域

### 修复

- **TUN 启动失败误报"密码错误或取消"** - 启动脚本失败时 `exit 1`，与 sudo 鉴权失败的退出码冲突，配置错误、端口占用等真实失败都被误报。脚本失败改用 `exit 2`，调用方据此区分；失败时同时清理 root 属主 pid 文件，避免后续 `start` 因残留死锁（旧提示只让 `pkill`，清不掉 pid 文件）
- **`reset subs` 半重置状态** - 只删订阅缓存/原始配置文件，settings 里的订阅列表保留，重置后 `start` 报"未找到订阅配置"。现同步清空订阅列表与 `active_subscription`
- **`sub add` 下载失败留下半成品订阅** - 订阅已写入并可能切为默认后下载才失败，之后 `start` 必然报错。现下载失败自动回滚（移除刚添加的订阅）
- **覆写文件顶层为数组时被当配置合并** - YAML 顶层数组能通过类型检查，被解构出数字键参与合并。现拒绝并告警
- **`sub web` 缺页面地址时覆盖已保存配置** - 回退路径重新下载订阅并落盘，副作用超出"打开页面"。现只取响应头，不写盘
- **`clean` 后订阅文件残留死节点规则** - 只清理了引用已删空分组的规则，直接引用死节点的规则留在文件里（靠构建时兜底）。现保存时一并清理
- **自动更新超时后全部计为失败** - 超时即丢弃已完成结果。现收齐已完成/已失败的更新再统计，超时只影响未完成的部分
- **`SUB-RULE` 规则被误删** - 配置校验按「末段为代理/分组名」检查规则目标，但 `SUB-RULE` 末段引用的是 sub-rule 名，被当作无效引用删除。现跳过此类规则的目标校验
- **空名覆写节点清空 include-all 分组** - 覆写注入 `name` 为空的节点时，exclude-filter 正则出现空分支（`a||b`）匹配所有节点，分组被清空。现过滤空/非字符串节点名
- **节点重命名未同步规则** - 保存时裁剪节点名只更新了 `proxies`/`proxy-groups`，规则里直接引用旧名会变悬空引用。现一并 remap `rules` 中的目标
- **`sub add` URL 校验过宽** - 仅判 `startsWith('http')`，`httpfoo://`、`http-evil` 等能通过。现用 `URL` 解析校验协议并 trim 首尾空白
- **`reset -f` 语义误导** - `-f` 是 `--full`（删全部）的别名，与常见 `-f=force` 直觉冲突，且未知标志（如拼错的 `--ful`）被静默忽略后走默认删除。现移除 `-f` 别名（删全部只认 `--full`，免确认统一 `-y/--yes`），未知标志一律报错退出
- **HTTP 下载无响应体大小上限** - 订阅/内核下载被劫持或故障返回超大响应时可能 OOM。现按 `Content-Length` 提前拒绝并流式读取，超 50MB 中止
- **`tar` 解压无路径穿越防护** - 恶意镜像可借含 `../`/绝对路径的归档条目写出目标目录之外。现解压前校验条目路径
- **内核进程创建失败处理** - 内核二进制不可执行时，`spawn` 的 error 事件无监听会冒泡为未捕获异常、`pid` 缺失会二次抛错。现监听 error 并在 pid 缺失时给出可读提示

### 安全

- **错误信息遮蔽路径型订阅令牌** - `maskUrl` 原仅遮蔽 query/userinfo，形如 `/subscribe/<TOKEN>` 的路径令牌会原样出现在错误日志。现对疑似令牌的长路径段一并遮蔽
- **`ui` 命令不再明文回显 `controller_secret`** - 改为提示密钥已配置、见 `settings.json`，避免进入 shell 历史/日志

### 变更

- **`allow-lan` 不再强制锁定** - 订阅/覆写显式提供时按其值（支持局域网设备连入代理端口的入站场景），未提供时默认 `false`
- **`sub` 列表改为纯只读** - 不再触发自动更新（更新是写操作），`sub add`/`use`/`update` 末尾的列表也不再顺带更新其他订阅。自动更新只在 `start` 与显式 `sub update` 时发生
- **启动自动清理加冷却** - 节点数超阈值时的自动测速清理改为同一订阅 12 小时内只跑一次（冷却记录在订阅缓存），新增 `--no-clean` 跳过；避免每次 `start` 都全量测速并可能二次重启
- **隐式停止不再弹 sudo** - `start`/`clean` 遇到 root 属主残留（TUN 实例等）时，不再由 `stop()` 内部 sudo 提权，改为报错引导手动清理或使用 `sub clean`（`stop` 命令本身的 sudo 提权保留）
- **可选 `controller_secret` 设置** - `settings.json` 设置后，external-controller 启用 Bearer 认证（系统锁定，订阅/覆写无法伪造），`ui` 命令会提示密钥；面向多用户环境
- **支持 `--flag=value` 形式** - `--timeout=3000`、`--mirror=url` 等与空格分隔形式等价
- **非 TTY 下测速不再逐节点刷屏** - 管道/重定向时只输出汇总行
- **`mihomo log` 的 Ctrl+C 不再打印"正在退出..."** - follow 场景这是常规退出
- **`status` 未运行时也显示模式** - 有配置文件时展示上次构建的 TUN/Mixed
- **`update` 权限失败给出 sudo 提示**
- **`test`/`clean` 与 `sub test`/`sub clean` 帮助区分** - 前者经运行中的主实例，后者用隔离实例、无需主实例运行
- **`status` TUN 模式端口显示** - 不再显示「未知」，改为「TUN 接管」并标注备用监听端口
- **`sub use`/`ow on`/`ow off` 触发重启时透传启动选项** - `-s`/`-t`/`-j`/`--no-clean` 等不再被丢弃
- **订阅「永久」到期显示** - 机场 `expire=0` 不再显示成 `1970-01-01`，改为「永久」
- **`curl` 未安装时明确提示** - 内核下载不再报「退出码 null」

### 内部

- 抽出 `src/progress.ts`（进度条与结果格式化），解开 `commands/start` ↔ `commands/subscription` 的循环依赖
- 订阅缓存损坏时与 settings.json 一致：先备份再回退默认
- 合并订阅任一来源失败即取消其余下载，不再白等
- `applyOverwrite` 恒返回浅拷贝，避免构建时的锁定键删除污染订阅原始对象（debug stage1 失真）
- `isGithubUrl` 对多 URL 合并订阅要求全部来源为 GitHub 才按 GitHub 策略
- `--mirror` 默认镜像收敛为 `DEFAULT_MIRROR` 常量（与可用镜像列表首项一致）
- `buildConfig(subRawContent, mode, scope?)` 新增可选订阅作用域参数（`{ subName, subUrl }`），由 `prepareConfigForStart` 组装传入；作用域过滤在 `buildConfig` 顶部统一执行一次，确保被排除的覆写文件不会污染 `exclude-filter` 与 debug 输出
- `match` 元数据键在 `loadOverwriteFile` 阶段即抽成结构化字段并从 config 剥离，保证它永不进入最终 mihomo 配置

## [3.2.0] - 2026-07-19

### 修复

- **测速隔离实例被主进程管理误杀/误判** - `getMihomoPids`（原 `getAllMihomoPids`）此前用 `pgrep -f <内核路径>` 匹配，会连带命中 `sub test`/`sub clean` 启动的、跑同一内核但 `-f` 指向 `test/runtime/config.yaml` 的隔离实例。导致主实例运行时另开终端测速，`stop`/`start` 会误杀测速实例、或把它误判为残留而拒绝启动。改用「内核路径 + 主 configFile」双段正则精确匹配主实例（三种启动方式命令行均含这两段），隔离实例与仅用编辑器打开配置的进程都不再命中
- **未捕获异常时测速实例泄漏** - `uncaughtException` / `unhandledRejection` / `main().catch` 退出前未执行清理，测速期间崩溃会残留端口 27890 的实例。现三处退出前均调用 `runCleanup()`（此前仅 SIGINT/SIGTERM 有）
- **TUN 启动脚本路径未安全转义** - 生成的 sudo bash 脚本用双引号直接拼接内核/配置路径，`MIHOMO_CLI_DIR` 含 `"`/`$`/反引号时存在本地注入面。改用单引号字面量转义（`shellQuote`，与 daemon 脚本同一范式）
- **带 `no-resolve` 的规则在启动时被误删** - `validateConfig` 校验规则时取逗号分隔的末段当目标，`IP-CIDR,1.1.1.1/32,DIRECT,no-resolve` 这类带 `no-resolve` 修饰后缀的规则，其末段是修饰词而非目标，会被当作"引用不存在目标"静默移除（机场订阅中很常见）。现提取 `getRuleTarget()`：末段为 `no-resolve` 时取倒数第二段；`clean` 的规则清理同步改用
- **`clean` 误删带 `include-all`/`use` 的分组** - `cleanDeadProxies` 只按 `proxies` 清空判定删组，未像 `validateConfig` 那样检查其他节点来源；`{include-all: true, proxies: []}` 这类分组（或引用节点恰好全死但有 `include-all` 兜底）会被从订阅文件里持久删除。补上一致的 `hasOtherSource` 检查
- **Mixed 模式未清理订阅残留的 `tun` 字段** - 订阅/覆写自带 `tun.enable: true` 时，`start`（Mixed）会以 TUN 静默启动，保活（限定 Mixed）也可能带 tun 配置被 launchd 拉起。现 Mixed 模式显式丢弃订阅侧的 tun 字段（TUN 模式仍由系统 `TUN_CONFIG` 强制覆盖）
- **`sub add` 同名订阅被静默覆盖** - 两次不带名称的 `sub add` 会让第二个直接替换 `default`，原订阅 URL 无提示丢失。现同名即报错，提示换名或先删除
- **内核下载可能选中 compatible 版**（Intel Mac）- `-compatible` 变体同样满足"版本号尾缀"判定且字母序靠前，会被优先当作标准版下载（性能低于标准版）。现显式排除，仅在无标准版时回退
- **订阅名路径穿越**（低危）- 原始配置路径直接拼接订阅名，手改 `settings.json` 塞入 `../` 可让读/写/删越出 subscriptions 目录。现统一校验名称合法性；`sub remove` 对非法名跳过文件清理、仍可正常从列表移除

### 变更

- **新增 `runtime.ts` 运行时门面** - 收敛「普通进程（pidFile） vs 保活（launchd 托管）」双轨差异：运行模式判定、运行状态/PID、启停重启统一为三个函数。命令层（`start`/`status`/`sub use`/`ow`/`clean`）不再各自 `if (isDaemonEnabled())` 分支，消除重复与不一致（此前 `clean` 两分支输出已分叉）
- **命令路由改为注册表驱动** - 新增 `commands/registry.ts`，以数据表描述命令的名称/别名/handler/argv 改写；`index.ts` 从表分发（消除 ~110 行手写 switch，模块加载时校验别名无冲突）。帮助文本的命令清单由各命令的 `usage` 生成（单一真相源），修复此前手写 `help` 与实际命令脱节的问题，并补上「快捷命令」映射说明
- **保活模式日志不再无限增长** - daemon 常驻时不经 `process.start`，日志轮转/归档清理从不触发。现 `restartDaemon` 检测日志超 10MB 时跳过热重载、改走 sudo kickstart 路径顺便 copy-truncate 轮转（daemon 日志为 root 属主，用户态无法 truncate；运行中 rename 会让 launchd 的日志 fd 继续写进归档文件，只能 copy-truncate），并顺带清理 7 天前归档
- **`sub update` 后提示重启生效** - 运行中的实例仍使用旧配置，更新完成后提示执行 `mihomo start`
- **`kernel` 命令输出精简** - 不再每次打印整段镜像用法；仅直连失败时才提示 `--mirror`/`--mirror-all` 与可用镜像列表

### 内部

- 提取共用工具消除重复：`escapeRegExp`、`shellQuote`（utils）、`dumpYaml`（config，合并 4 处相同 YAML 序列化选项）
- `external-controller` 地址统一为常量 `CONTROLLER_ADDR`（constants），供配置生成、测速探测、热重载共用；删除 daemon 中因地址恒定而永不触发的运行时端口解析
- `HttpClient.get<T>()` 泛型化，json 模式直接返回目标类型，去掉调用点的 `as unknown as` 强转
- 覆写文件名判定提取为 `isOverwriteFilename`（overwrite），reset 复用
- 归档日志时间戳从 UTC 改为本地时间（与 `logs` 列表展示的 mtime 时区一致），提取 `formatLocalTimestamp`（utils）
- 常量收敛：`CONTROLLER_BASE_URL` 入 constants（daemon 热重载与测速探测共用，删除重复的地址构造）；`DAEMON_BOOT_WAIT_MS` 合并两处重复的 launchd 等待定义；`cleanupOldLogs` 导出供 daemon 复用
- 文档同步：CLAUDE.md 架构表补上 `lifecycle.ts`；`allow-lan` 强制 false 标注为有意安全默认（防覆写误开入站代理）；README 安全章节说明 controller 仅监听回环、无鉴权的适用边界

---

## [3.1.0] - 2026-07-19

### 修复

- **保活模式下经局域网跳板的代理连不通**（v3.0.0 引入的严重 bug）- 用户级 LaunchAgent 启动的内核受 macOS 15+ 本地网络隐私（TCC）限制，访问**局域网其他设备**被静默拦截（报 `no route to host`），导致经局域网 socks5 跳板转发的内网流量在 `daemon on` 后全部失效、`daemon off` 后立刻恢复。手动在系统设置授权对裸命令行二进制无效。改为 **root 级 LaunchDaemon** 彻底解决（系统上下文不受该限制）

### 变更

- **保活迁移到系统级 LaunchDaemon** - plist 位于 `/Library/LaunchDaemons/`（`root:wheel`），以 root 运行；`daemon on` / `daemon off` 需输入一次管理员密码（复用 TUN 模式的交互式 sudo 范式，一次密码完成全部操作）
- **配置变更优先热重载（免密）** - `sub use` / `ow on|off` / `clean` 等触发的重启优先经 external-controller `PUT /configs` 热重载（走 localhost、无需 sudo），失败才回退到需密码的 `launchctl kickstart`
- **`daemon status` / `status` 免密** - 保活状态查询改用 `pgrep` + root 属主过滤判定运行状态，不再调用需 sudo 的 `launchctl print`
- **关闭保活时归还文件属主** - `daemon off` 会把 root 守护进程创建的日志、数据文件 `chown` 回当前用户，避免后续非保活模式 `start` 因 root 属主日志无法写入而失败
- `daemon on/off` 在非交互终端（无 TTY，如 CI）会明确报错而非挂起

---

## [3.0.0] - 2026-07-19

### 新增

- **进程保活（`daemon`）** - 基于 macOS 原生 launchd（LaunchAgent），让 mihomo 内核在崩溃、被系统 kill、开机/重新登录后自动拉起，代理后台常驻
  - `mihomo daemon on` - 开启保活（生成 LaunchAgent、`KeepAlive` 崩溃重启 + `RunAtLoad` 开机自启，仅 Mixed 模式，装载无需 sudo）
  - `mihomo daemon off` - 关闭保活并停止代理
  - `mihomo daemon status` - 查看保活状态
  - 零额外常驻进程、零轮询：保活由系统 launchd 兜底，不占用系统资源

### 变更

- **保活开启时的生命周期联动** - 启用保活后，`start` / `clean` / `ow on|off` / `sub use` 的重启改走 `launchctl kickstart`（不再裸 `kill`，避免与 `KeepAlive` 打架）；`stop` 会提示改用 `daemon off`；`start tun` 会提示保活仅支持 Mixed，需先 `daemon off`
- **`status` 显示保活状态** - 保活开启时，运行状态以 launchd 托管进程为准（托管进程不写 pidFile）
- **`reset` 支持 `daemon` 目标** - `reset daemon` / `reset --full` 会先卸载 launchd 任务再删除 plist；例行 `reset`（无参）默认保留保活

---

## [2.10.0] - 2026-07-18

### 依赖升级

- **js-yaml 4 → 5**（破坏性大版本）：迁移到命名空间导入，`noCompatMode` 选项移除后改用 `CORE_SCHEMA`（YAML 1.2 语义），保持 `yes/no/on/off` 等值不被错误加引号，与 mihomo 内核解析一致；移除随之内置类型的 `@types/js-yaml`
- **TypeScript 6 → 7**（原生编译器）：类型检查更快，构建仍走 tsup/esbuild
- **lint-staged 16 → 17**：随之将 `engines.node` 门槛从 `>=22.0.0` 抬高到 `>=22.22.1`
- 其他：Biome 2.4 → 2.5、tsx 4.21 → 4.23、@types/node 22.19 → 22.20

### 修复

- **`mihomo tun` 丢弃命令行参数** - `mihomo tun -s`、`mihomo tun -u 30000 -t 3000` 等此前被静默忽略（快捷命令未透传参数），现与 `mihomo start tun ...` 行为一致

### 优化

- **默认值常量收归 `constants.ts`** - 测速超时/并发（2000/100）、清理轮次、自动更新超时、自动清理阈值、更新间隔等默认值统一集中管理，消除散落的裸魔数
- **消除重复逻辑** - 订阅下载的缓存元信息组装（`downloadSubscription` / `downloadMergedSubscription`）、进程停止失败处理（start/stop/clean 三处）、更新结果打印、单订阅下载分派统一抽取复用
- **清理冗余导出** - 移除仅在本模块内使用的多余 `export`
- **文档一致性** - README 镜像列表与代码对齐；`dir open` 帮助补列 `data` 目标

---

## [2.9.2] - 2026-07-18

### 修复

- **带值选项被误当参数** - `sub test -t <ms>`、`sub clean -r <轮数>`、`logs -n <行数>` 等命令在不显式指定名称时，选项的值（如 `3000`）会被误认为订阅名/日志编号导致报错。现已正确识别，这些选项可独立使用

### 安全 / 健壮性

- **内核下载后自检** - 下载解压内核后立即运行 `mihomo -v` 校验二进制可执行且未损坏（架构不匹配、下载截断等），失败则删除并报错（mihomo 上游未提供 checksums，故以自检替代哈希校验）
- **镜像下载来源提示** - 使用 `--mirror` 经第三方中转下载内核时，提示无法验证来源完整性
- **自动更新超时竞态** - 自动更新订阅超时后，真正中断底层网络请求（此前请求仍会在后台跑完并写盘，与「已用缓存启动」的主流程存在竞态）
- **清理失败节点同步清理规则** - `clean` 删除空代理组后，同步移除订阅配置中引用这些已删组的规则，避免残留

### 其他

- 清理未使用代码，简化进程信息采集

---

## [2.9.1] - 2026-06-28

### 修复

- **测试实例进程泄漏** - `sub test` / `sub clean` 期间按 Ctrl+C 不再残留测试内核进程（端口 27890）。新增统一的退出清理机制（`lifecycle.ts`），信号退出前同步清理
- **`clean` 模式降级** - `mihomo clean` 清理后重启时保留当前运行模式，TUN 用户不再被静默切回 Mixed
- **`sub web` 打开错误订阅** - 无参数时打开当前激活订阅，而非第一个添加的订阅
- **订阅更新间隔校验** - 机场返回非正数的 `profile-update-interval`（如 -1）时回退默认间隔，不再每次启动都重新下载
- **内核版本探测超时** - `getKernelVersion` 增加 5 秒超时，损坏的内核二进制不再导致命令永久卡死

### 安全 / 健壮性

- **去除 shell 命令拼接** - 进程管理、内核解压等处的 `execSync` 字符串拼接全部改用 `spawnSync` 参数数组，消除路径注入风险
- **进程匹配精确化** - `pgrep` / `pkill -f` 的路径模式做正则转义，避免路径中的 `.` 被当作通配符误匹配/误杀其他进程
- **原子文件写入** - settings、订阅缓存、运行时配置改为「写临时文件 → 重命名」，避免写入中途崩溃导致文件损坏
- **settings 损坏备份** - `settings.json` 解析失败时自动备份为 `.bak`，避免被默认值覆盖丢失
- **其他** - `formatBytes` 处理 `Infinity`；`isProxyValid` 兼容 SS2022 base64url 密钥；`ui` / `dir open` 防原型链属性；内核归档目录递归加深度限制

---

## [2.9.0] - 2026-05-13

### 新功能

- **跳过自动更新** - `start -s` 跳过启动时的订阅自动更新
- **自动更新超时** - `start -u <ms>` 设置自动更新超时时间（默认 10 秒），超时后使用缓存配置继续启动
- **通用 Promise 超时工具** - 新增 `withTimeout` / `TimeoutError` 工具函数

### 变更

- **命令别名调整** - 移除 `mmc`，新增 `mhm` 作为命令别名

---

## [2.8.1] - 2026-05-07

### 修复

- **stop/down 不再误触 sudo** - 非 TUN 模式启动的进程停止时不再提示输入 root 密码

---

## [2.8.0] - 2026-05-05

### 新功能

- **start/up 支持测速参数** - `-r N` 清理轮次、`-t ms` 超时、`-j N` 并发数
- **GitHub 订阅差异化策略** - 自动清理阈值 GitHub 50 / 其他 100；默认更新间隔 GitHub 6h / 其他 12h

### 改进

- **默认测速轮次** - 从 3 轮调整为 2 轮
- **统一超时默认值** - 所有测速命令默认超时统一为 2000ms

---

## [2.7.3] - 2026-05-04

### 改进

- **代码清理** - 提取 `DEFAULT_CLEAN_ROUNDS` 常量，消除重复魔数；简化进度条内部状态

---

## [2.7.2] - 2026-05-04

### 修复

- **进度条轮次标题** - 多轮测试时第 1 轮标题正确显示在进度条之前，单轮不显示轮次标题

### 改进

- **自定义轮数** - clean 命令支持 `-r N` / `--rounds N` 指定测试轮数（默认 3）

---

## [2.7.1] - 2026-05-04

### 修复

- **进度条计数器修复** - 清理/测试多轮重试时，✓/✗ 计数不再跨轮累加，每轮独立计数
- **轮次标题位置修复** - 移除错位的"第 1 轮测试"标题，重试轮标题正确显示在对应进度条之前

---

## [2.7.0] - 2026-05-03

### 移除

- **bench 命令** - 移除免费订阅源基准测试功能
- **sub free 子命令** - 移除内置免费订阅源快速添加功能

---

## [2.6.3] - 2026-05-03

### 改进

- **自动清理三轮重试** - 节点测试失败后自动重试两轮，三轮都失败才删除，减少网络抖动导致的误删
- **实时进度条** - 测试/清理过程中显示单行刷新进度条，测完输出按名称排序的最终结果
- **并发模型优化** - 节点测试从分批等待改为 worker pool，逐个完成即时反馈
- 重试通过的节点标注轮次（第N轮通过）
- start/test/clean 命令统一使用进度条

---

## [2.6.2] - 2026-05-03

### 改进

- **配置校验增强** - 新增重名节点/分组去重、无效规则清理，覆盖更多启动失败场景
- 移除多余的 `mihomo -t` 预校验（启动本身即校验）

---

## [2.6.1] - 2026-05-03

### 修复

- **启动前配置校验** - 自动检测并修复 proxy-group 中引用不存在的节点/分组，避免内核启动失败

### 改进

- 移除已废弃的 `global-client-fingerprint` 配置项，消除内核启动时的 warning

---

## [2.6.0] - 2026-05-03

### 改进

- **统一使用 mixed-port**：用 `mixed-port: 7890` 替代原来的 `port: 7890` + `socks-port: 7891`，单端口同时支持 HTTP 和 SOCKS5
- **BASE_CONFIG 优化**：新增 `unified-delay`、`tcp-concurrent`、`geo-auto-update`、`profile.store-selected`，不再依赖订阅自带这些配置
- **自动启用 sniffer**：检测到 `fake-ip` 模式时自动注入 sniffer 配置（嗅探 HTTP/TLS/QUIC），确保域名规则正常工作；订阅自带 sniffer 时不覆盖

---

## [2.5.0] - 2026-05-03

### 新功能

- **test 命令** - `mihomo test` 快速测试当前运行实例的节点连通性
- **clean 命令** - `mihomo clean` 清理失败节点并自动重启

### 改进

- `sub test` / `sub clean` 改用独立临时进程测试，不影响当前代理，支持测试任意订阅（不限于活跃订阅）
- 启动时 auto-clean 使用当前运行实例直接测速，提升启动速度

### 移除

- 移除 `sub best` 命令

---

## [2.4.2] - 2026-05-02

### 改进

- 自动清理阈值统一为 50 个节点（不再区分订阅类型）
- 订阅默认更新间隔从 12 小时缩短为 4 小时

---

## [2.4.1] - 2026-05-02

### 修复

- 启动时清除代理环境变量（`http_proxy` / `https_proxy` / `all_proxy`），避免系统已有代理导致请求异常

---

## [2.4.0] - 2026-05-02

### 新功能

- **sub best** - `sub best <id>` 一键添加聚合订阅（每小时自动更新、去重、测活）
  - `best 1` 精选 29 组（仅测速源：FreeSubsCheck, shaoyouvip, dalazhi, getnode）
  - `best 2` ACL4SSR 29 组（全部 7 个源）
  - `best 3` freeSub 24 组
- **新增免费源** - yahr601, Auto-Sync, ssrsub, dalazhi, getnode

### 修复

- `setDefaultSubscription` 移到下载成功后再设置，避免下载失败留下无效默认订阅

---

## [2.3.1] - 2026-05-02

### 新功能

- **合并订阅** - `sub add url1,url2 name` 支持逗号分隔多 URL，合并节点（按名去重），分组/规则取第一个源
- **sub free 0** - 特殊 ID `0` 自动合并免费源 #1 + #2（节点更多，配置相同）

### 改进

- 合并订阅在列表中显示 `[合并 N 源]` 标记
- `sub update` 自动识别合并订阅并重新下载合并
- URL 脱敏支持逗号分隔多 URL

---

## [2.3.0] - 2026-05-02

### 新功能

- **bench 命令** - 内置 20 个免费订阅源基准测试，下载→启动独立实例→测速→排名。支持 `-t` 超时、`-j` 并发、按名过滤
- **sub free 命令** - `sub free <id>` 快速添加内置免费订阅（命名 free1/free2/...），自动切换并支持 `sub web` 跳转 GitHub 页面
- **启动自动清理** - free* 订阅超 50 节点、其他超 100 节点时启动后自动测速清理
- **overwrite 代理排除** - 通过 `+proxies` 注入的代理自动从 `include-all: true` 分组中排除

### 改进

- **启动失败详情** - 启动失败时显示完整 mihomo 日志（不再截断），便于定位 GeoSite/规则等配置错误
- **CJK 表格对齐** - bench 排名表使用 `displayWidth` 处理中文字符宽度

---

## [2.2.4] - 2026-05-01

### 修复

- **reset 命令误触 sudo**：修复 `reset` 停止进程时强制使用 sudo 的问题，改为自动检测是否需要提权

### 改进

- **重命名 `shortenProxyNames` → `normalizeProxyNamesBeforeSave`**：明确该函数是写入前的预处理步骤，避免误用

---

## [2.2.3] - 2026-05-01

### 修复

- **非 TUN 模式误触 sudo**：修复 `start` 命令在 mixed 模式下停止旧进程时强制使用 sudo 的问题，改为自动检测是否存在 root 进程再决定是否提权

---

## [2.2.2] - 2026-05-01

### 修复

- **文件描述符泄漏**：修复 `startMixedMode` 中 spawn 后未关闭 fd 的问题
- **forceSudo 参数失效**：修复 `cleanupAll` 忽略调用方传入的强制 sudo 参数
- **formatBytes 溢出**：修复超大字节值（>1PB）导致显示 `undefined` 单位
- **YAML 解析类型检查**：`parseYamlOrJson` 现在拒绝非对象类型的 YAML 内容
- **spawn 错误处理**：`openUrl` 添加 error 事件处理，防止未捕获异常
- **UserInfo 类型转换**：移除 `parseUserInfo` 中多余的 `as unknown` 双重转换

### 安全

- **订阅名称校验**：新增文件名安全校验，防止路径穿越等不安全名称

---

## [2.2.1] - 2026-05-01

### 修复

- **节点名称精简时序**：修复 `shortenProxyNames` 在测速前执行导致 API 返回 "Resource not found" 的问题，改为测速完成后再精简
- **清理安全阈值**：存活节点不足 1% 时跳过清理，提示用户检查原始订阅

---

## [2.2.0] - 2026-05-01

### 新增

- **节点测速**：`sub test [name]` 测试订阅节点连通性，支持 `-t` 超时和 `-j` 并发参数
- **节点清理**：`sub clean [name]` 测速后自动清理不可用节点，移除空分组
- **启动自动清理**：`start` / `start tun` 启动时，节点数超过 100 自动执行清理

### 安全

- **强制端口配置**：HTTP 端口固定 7890，SOCKS5 端口固定 7891，忽略订阅中的 `mixed-port` 配置

---

## [2.1.0] - 2026-05-01

### 新增

- **删除订阅**：`sub remove <name>` 删除订阅（别名 `rm`/`delete`），同时清理缓存和配置文件
  - 删除当前使用中的订阅时自动切换到第一个剩余订阅
- **添加即切换**：`sub add` 添加订阅后自动切换为当前使用的订阅

### 安全

- **强制 `allow-lan: false`**：无论订阅配置如何，始终禁止局域网访问
- **强制 `external-controller: 127.0.0.1:9090`**：控制面板仅监听本地，防止不可信订阅暴露控制接口
- **剥离 `external-ui` 相关字段**：构建配置时强制删除 `external-ui`/`external-ui-name`/`external-ui-url`，防止订阅触发额外下载

### 优化

- **TUN DNS 劫持**：`dns-hijack` 从 `['0.0.0.0:53']` 改为 `['any:53', 'tcp://any:53']`，同时劫持 UDP 和 TCP DNS，覆盖 IPv4/IPv6
- **帮助顺序统一**：订阅子命令统一为 use → add → update → remove → web 顺序
- **`removeSubscription` 返回切换信息**：返回自动切换到的订阅名，避免调用方重复读取状态
- **`setDefaultSubscription` 跳过冗余写入**：已是同值时直接返回
- **删除后跳过自动更新**：`sub remove` 后列出订阅时不触发网络更新

---

## [2.0.1] - 2026-04-22

### 修复

- **TUN DNS 默认值**：使用属性存在性检查替代 falsy 检查，避免订阅中 `dns.enable: false` 等值被覆盖
- **覆写文件名显示**：`overwrite.yaml` 不再显示为 "yaml"，改为 "主文件"

### 优化

- **消除重复文件扫描**：覆写文件加载从每次构建 2 次减少为 1 次
- **清理死代码**：移除 `resetUserData`、`getGitHubMirror`、`setGitHubMirror`、未使用的类型字段

---

## [2.0.0] - 2026-04-11

### 架构重写

完整重写为 TypeScript，保持所有功能不变。

- **语言**：JavaScript (CJS) → TypeScript (ESM)
- **构建**：tsup 单文件打包 (esbuild)，产物 ~170KB
- **运行时**：Node.js >= 22
- **工具链**：eslint + prettier → Biome；axios → 原生 fetch
- **类型系统**：`src/types.ts` 集中管理所有类型定义
- **模块拆分**：`config.js` (517 行) → `paths.ts` + `settings.ts` + `config.ts`
- **命令处理器**：从 `index.js` (1177 行) 拆分为 `src/commands/` 下 12 个独立文件

### 变更

- **命令别名**：`mmc` → `mhm`（避免误解）
- **依赖精简**：移除 axios，运行时仅依赖 js-yaml + compare-versions（已打包进单文件）
- **开发依赖**：TypeScript 6、tsup 8.5、tsx 4.21、Biome 2.4

## [1.5.1] - 2026-04-11

### 修复

- 修复内核下载时引用不存在的目录键 `DIRS.core`，导致下载失败 (`kernel`)
- 修复订阅页面打开时调用不存在的函数 `readSubscriptionsCache`，导致报错 (`sub web`)

## [1.5.0] - 2026-04-10

### 新增功能

- **快捷命令**：新增顶层命令快捷方式，减少输入
  - `mihomo up` = `mihomo start`
  - `mihomo down` = `mihomo stop`
  - `mihomo tun` = `mihomo start tun`
  - `mihomo use <name>` = `mihomo sub use <name>`
  - `mihomo on` / `mihomo off` = `mihomo ow on` / `mihomo ow off`
  - `mihomo open <target>` = `mihomo dir open <target>`
- **订阅选择机制**：使用 `active_subscription` 字段标识当前订阅，不再依赖数组顺序
- **配置构建调试**：运行时目录生成 3 阶段中间文件，方便排查配置问题
  - `1.subscription.yaml` — 订阅原始配置
  - `2.overwrite.yaml` — 覆写合并内容
  - `3.system.yaml` — 系统补充值（BASE_CONFIG + TUN）

### 重构

- **目录结构调整**：
  - `core/` → `kernel/`（内核目录）
  - `.runtime/` → `runtime/`（运行时目录）
  - `overwrites/` 目录 → 根目录 `overwrite.yaml` + `overwrite.*.yaml`（覆写文件扁平化）
- **配置合并逻辑**：BASE_CONFIG / TUN_CONFIG 改为只补充订阅中缺失的字段，不再强制覆盖已有值
- **TUN 模式**：移除 `ipv6: false` 硬编码，交由订阅或覆写控制
- **`dir open` 目标精简**：移除 `overwrites` 和 `settings`，保留 `root|subs|logs|data|runtime|kernel`

### 优化

- **文案调整**：
  - "默认订阅" → "当前订阅" / "使用中"
  - 覆写文件名显示去除 `overwrite.` 前缀
  - 覆写配置 "目录" → "位置"
- **dir 信息**：新增显示内核目录路径

---

## [1.4.1] - 2026-04-08

### 优化

- **状态显示文案**：
  - `○ 已停止` → `不在运行`（移除符号，更简洁明确）
  - `未在运行` → `不在运行`（统一措辞）
- **代码风格统一**：标签输出格式统一为 `colors.gray('标签: ')`

---

## [1.4.0] - 2026-04-07

### 新增功能

- **reset 命令增强**：
  - 支持按目标名称模糊删除：`mihomo reset subs logs` 删除订阅和日志
  - 可用目标：`subs`, `logs`, `kernel`, `overwrites`, `settings`, `data`, `runtime`
  - `--full` 删除全部
  - 留空默认保留：设置、内核、覆写配置
- **kernel 镜像改进**：
  - 默认改为**直连**下载（不再强制使用镜像）
  - `--mirror` 不带参数时使用默认镜像 `v6.gh-proxy.org`
  - `--mirror hk.gh-proxy.org` 指定镜像
  - `--mirror-all` API 请求和下载都使用镜像（解决 API 访问受限问题）
  - 命令中列出所有可用镜像

### 修复

- **reset 覆写目录**：补充删除 `overwrites` 目录
- **reset 保留逻辑**：修复覆写配置的保留/删除逻辑

### 优化

- **状态显示**：运行中/已停止添加图标区分
  - `● 运行中` (绿色)
  - `○ 已停止` (黄色)
- **措辞明确**：动作成功的"已停止"改为"已停止进程"，避免与状态显示混淆
- **代码重构**：
  - 常量提取：`BATCH_KILL_THRESHOLD` 等
  - 镜像处理逻辑优化，新增 `normalizeMirrorUrl()` 统一处理

---

## [1.3.1] - 2026-04-07

### 优化

- **短帮助命令顺序**：调整常用命令展示顺序，`ui` 放最后，`ow` 提前到第三位

---

## [1.3.0] - 2026-04-07

### 架构重构

- **代码组织优化**：将 `index.js` 中的业务函数迁移到对应模块，职责更清晰
  - `getActiveSubscription`, `findSubscriptionFuzzy`, `pickSingleSubscription` → `subscription.js`
  - `parseMirrorArg`, `normalizeMirrorUrl` → `utils.js`
  - `openLogFile`, `viewLogWithTail` → `process.js`
  - `DIRECTORY_TARGETS` → `config.js`

### 代码质量

- **统一 HTTP 客户端**：在 `utils.js` 中添加 `createHttpClient()` 函数，统一 `User-Agent` 为 `mihomo-cli/${VERSION}`
- **常量提取**：将硬编码的超时、等待时间等提取为命名常量
  - `PROCESS_WAIT_ATTEMPTS`, `PROCESS_WAIT_INTERVAL`
  - `STARTUP_WAIT_MS`, `SUDO_TIMEOUT_MS`, `TUN_MODE_POST_WAIT_MS`
  - `DEFAULT_LOG_RETENTION_DAYS`
  - `KERNEL_HTTP_TIMEOUT`, `KERNEL_MAX_CONTENT_LENGTH`, `KERNEL_DOWNLOAD_TIMEOUT`

### 开发工具链

- **ESLint**：配置 ESLint v10 + `@eslint/js` + `globals`，自动检测未使用变量/导入
- **Husky**：配置 Git hooks
- **lint-staged**：提交前自动运行 `eslint --fix` + `prettier --write`
- **Import 风格统一**：所有文件统一使用「内置模块 → 第三方模块 → 本地模块」的分组顺序和空行

### 清理

- 移除未使用的变量导入
- 未使用的 catch 错误变量统一使用 `_e` 前缀

---

## [1.2.5] - 2026-04-07

### 新增功能

- **update 命令**：新增 `mihomo update` 命令，执行 `npm install -g mihomo-cli` 快速更新 CLI 版本
  - 支持别名：`update`、`upd`、`upgrade`

---

## [1.2.4] - 2026-04-07

### 修复

- **路径安全**：`getLogPathByName()` 增加 `isPathUnderDir()` 校验，防止潜在的路径遍历风险
- **错误提示**：覆写配置文件解析失败时显示警告日志，不再静默忽略

### 重构

- **代码结构**：工具函数（`sleepSync`、`formatBytes`、`isProcessRunning` 等）提取到 `utils.js` 模块，简化各模块依赖
- **命名规范**：统一函数命名为全称单数
  - `autoUpdateStaleSubscriptions` → `autoUpdateStaleSubscription`
  - `applyOverwrites` → `applyOverwrite`
  - `loadOverwriteFiles` → `loadOverwriteFile`
  - `listOverwriteFiles` → `listOverwriteFile`

---

## [1.2.3] - 2026-04-07

### 优化

- **简短帮助**：大幅精简，只列出最常用命令，增加 `mihomo help` 提示
- **性能**：
  - settings 读取增加内存缓存，减少重复 JSON 解析
  - 内核版本增加缓存，避免重复执行 `mihomo -v`
  - `sleepSync()` 改用 `Atomics.wait` 而非 `execSync('sleep')`，减少子进程开销

### 重构

- 精简模块导出接口，移除不必要的内部函数导出
- 新增 `formatProxySummary()` 复用函数（消除 3 处重复代码）
- `pickSingleSubscription()` 移除多余参数
- 统一代码风格：数组/条件表达式换行风格、`cmdUi` → `cmdUI` 命名一致性

### 文档

- README 修复：GitHub 链接、重复段落、`profile-update-interval` 格式

---

## [1.2.2] - 2026-04-05

### 优化

- **简短帮助**：`subscription` 简化为一行
- **详细帮助**：补充完整的子命令列表（`list`、`directory open` 等）

### 修复

- 回滚 v1.2.1 中对详细帮助的错误修改（详细帮助保持多行格式）

---

## [1.2.1] - 2026-04-05

### 文档

- README 添加覆写配置和自动重启说明
- CLAUDE.md 精简和完善，增加发布检查清单

### 文档

- README 添加覆写配置和自动重启说明
- CLAUDE.md 精简和完善，增加发布检查清单

---

## [1.2.0] - 2026-04-05

### 新增功能

#### 配置变更自动重启

- **sub use 自动重启**：切换默认订阅后，如果 mihomo 正在运行则自动重启
- **ow on/off 自动重启**：启用/禁用覆写配置后，如果 mihomo 正在运行则自动重启
- **状态检查**：操作前检查是否已是目标状态，避免重复操作

### 重构

#### 命名规范统一

- **函数重命名**：统一使用全称单数
  - `findSubsFuzzy` → `findSubscriptionFuzzy`
  - `pickSingleSub` → `pickSingleSubscription`
  - `printSubList` → `printSubscriptionList`
  - `cmdSub` → `cmdSubscription`
  - `cmdDirs` → `cmdDirectory`
  - `DIR_TARGETS` → `DIRECTORY_TARGETS`
- **帮助文档统一**：
  - 示例统一使用 `mihomo` 而非 `mihomo-cli`
  - 命令列表使用全称单数 `directory` 而非 `directories`
  - 提示语中的命令示例添加 `mihomo` 前缀

### 修复

- 修复缺失的 `path` 模块导入
- 统一引号风格（命令示例使用双引号）

## [1.1.0] - 2026-04-05

### 新增功能

#### 覆写配置

- **覆写配置功能**：支持在订阅配置基础上进行自定义覆写
  - `ow` / `overwrite` 命令：
    - `ow` / `ow list`：查看覆写配置状态和文件列表
    - `ow on` / `ow off`：启用/禁用覆写配置
  - **覆写文件位置**：`~/.mihomo-cli/overwrites/` 目录
  - **支持的合并策略**：
    - `key!`：强制覆盖整个对象
    - `+key`：数组前置插入
    - `key+`：数组追加
    - `<+key>`：处理特殊键名
  - **执行顺序**：按文件名顺序加载，后面的文件覆盖前面的配置

### 优化

#### 输出格式

- 统一输出格式，移除操作提示开头的 2 空格缩进
- 操作结果和列表之间自动添加空行分隔
- `start` 命令启动后自动显示完整状态信息
- `sub` / `ow` 操作后自动刷新列表显示

#### 文案统一

- 节点显示统一为「组在前，节点在后」的格式：`16 组, 89 节点`
- 统一「部分进程未终止」文案
- 优化状态显示对齐（`PID` 单独多 1 空格对齐）

#### 命令改进

- `ow` 无参数时等同于 `ow list`
- `sub` 无参数时等同于 `sub list`
- 帮助文档中移除 `list` 子命令展示（无参即 list）

## [1.0.3] - 2026-04-05

### 文档修复

- **数据目录路径**：修正 README 中的用户数据存储位置
  - `~/Library/Application Support/mihomo-cli/` → `~/.mihomo-cli/`
  - 修正目录结构：`runtime/` → `.runtime/`，删除不存在的 `config/` 子目录
- **CLI 帮助文档**：修正 `log`、`logs`、`kernel` 命令的语法和描述
  - `logs` 命令明确 `0`=当前日志，`1+`=归档日志
  - 补充 `-o` 选项说明

## [1.0.2] - 2026-04-05

### 修复

- **版本号同步**：`index.js` 不再硬编码版本号，改为从 `package.json` 读取
  - 修复 `1.0.1` 发布后 `--version` 仍显示 `1.0.0-alpha.1` 的问题

## [1.0.1] - 2026-04-05

### 新增功能

#### 订阅管理增强

- **订阅信息解析**：自动解析 `subscription-userinfo` 响应头
  - 显示已用流量 / 总流量 / 到期时间
  - 从 `content-disposition` 提取用户名
  - 保存 `profile-update-interval`、`profile-web-page-url`

- **数据分离存储**：
  - 静态配置（name, url, updatedAt）→ `settings.json`
  - 动态数据（流量、用户名、页面URL）→ `subs-cache.json`

- **自动更新过期订阅**：
  - 默认间隔 12 小时（或订阅服务端指定的 `profile-update-interval`）
  - `start` 命令、`sub list` 命令时自动触发检查
  - 并行更新所有过期订阅，失败时使用本地缓存

- **订阅命令增强**：
  - `sub use <name>`：设置默认订阅（支持模糊匹配）
  - `sub web [name]`：打开订阅页面（无参打开默认）
  - `sub update`：无参时更新所有订阅
  - **模糊匹配**：精确匹配 → 前缀匹配 → 包含匹配，多匹配时提示

#### 日志管理

- **日志轮转**：每次启动前自动归档当前日志
  - 命名格式：`mihomo.YYYY-MM-DD_HH-MM-SS.log`
- **自动清理**：默认保留 7 天日志
- **新命令**：
  - `logs`：列出当前和归档日志（按时间排序）
  - `logs <编号>`：查看指定归档日志
    - `-n N`：指定显示行数（默认 100）
    - `-o`：用系统默认编辑器打开
  - `log -o`：用系统编辑器打开当前日志

#### 内核更新增强

- **镜像参数支持**：
  - `kernel hk.gh-proxy.org`：使用指定镜像
  - `kernel --mirror <url>`：显式指定镜像
  - `kernel --no-mirror` / `--direct`：直连，不使用镜像
- **镜像配置持久化**：
  - `getGitHubMirror()` / `setGitHubMirror()`
  - 默认：`https://v6.gh-proxy.org/`
  - 可用镜像列表在命令中列出
  - 空字符串 `""` 或 `false` 表示禁用镜像

#### 命令别名

新增以下命令别名，任意一个均可调用：

- `mihomo`
- `mmc`
- `mh`

#### 启动流程改进

- `start` 命令现在包含完整的重启/切换逻辑：
  - 先检查并自动更新过期订阅
  - 再完全停止现有进程（即使没进程也清理运行时文件）
  - 最后启动新进程
- **移除** `restart` 命令（`start` 已包含）
- **移除** `clean` 命令（`stop` 已包含清理）

### 改进

- 配置模块 `parseYamlOrJson()`：统一的 YAML/JSON 解析
- 订阅列表 `sub list` 显示：
  - 默认订阅标记 `[默认]`
  - 更新时间 / 更新间隔
  - 用户名（如有）
  - 流量使用：已用 / 总量 + 百分比
  - 到期时间
  - 订阅页面 URL
- `rmrf()` 改用原生 `fs.rmSync(recursive: true, force: true)`
- 启动脚本日志改为追加模式 (`>>`) 而非覆盖

### 移除

- 移除 `geodata` 相关功能：
  - `GEODATA_REPO`、`GEODATA_FILES` 常量
  - `downloadGeodata()` 函数
  - `downloadFile()` 内联函数

## [1.0.0-alpha.1] - 2026-04-05

- 初始版本发布
- 基础功能：启动/停止、订阅管理、内核更新、Web UI
