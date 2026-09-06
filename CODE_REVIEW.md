# 代码审查：风险与教训

> 当前基线：v4.7.5
> 上次全面审查：2026-09-06（第二轮独立复审，聚焦「文档未覆盖」与「防线只铺一条路径」的同族缺口，修复 3 项缺陷 + 3 项过度设计）

**这份文档只记录两类内容**：本轮发现的未处理项，以及**验证过、下轮不必重查**的结论。

**与 CLAUDE.md 的分工**：规则与纪律（改代码必须遵守的）以 CLAUDE.md 为唯一真相源；本文只记验证结论与未处理技术债，规则本身不重复，需要时指向 CLAUDE.md。

已修复条目不在此长期留存——规则类教训提炼进 `CLAUDE.md` 的「工作规则」，事故的实测细节锚进对应代码的函数头注释（co-located、随代码 review），修复细节留在 `CHANGELOG.md` 与 git 历史里。此前本文积累了 v3.6.0/v3.8.0 两轮的逐项修复清单共 24+10 条，其中涉及已删除功能（ssh 隧道、节点测速、多源合并订阅）的条目占了近三分之一，复核时才发现「记录属实但代码已不存在」——这种维护成本没有对应收益，故不再保留。

**维护约定**：
- 结论要给复现步骤，不要静态推测
- 改动涉及本文条目时同步更新
- 下轮审查前先复核「未处理项」，不要直接沿用

---

## 未处理项

### 观察窗之后才崩溃的内核判不出来

`waitServiceHealthy` 只覆盖「启动后立即退出」（配置解析失败的典型形态）。跑了几秒才 OOM 或 panic 的内核，`start` 仍会报成功——由 `status` 的「上次异常退出」提示兜底（v4.7.3 起该提示也覆盖信号死亡，OOM 被 kill 的场景不再无声）。这是有意的边界：要覆盖它就得让 `start` 挂在那儿等更久，代价不划算。

---

## 决策豁免：不做自动化测试的两类路径

v4.7.3 评估后确认不做，理由如下。**下轮审查不要当成待办重新捡起来**——要推翻需要新的事实（如出现了免侵入的验证手段），而不是「覆盖率不够」这个理由本身。

### 需要 sudo 的路径（TUN 启动、legacy root daemon 清理）

`process-start.ts` 的 TUN 启动脚本与 `reset`/`stop` 的 legacy 清理必须真提权，侵入性有三层，都不可接受：

- **要么配免密 sudoers（开发机不该配），要么测试挂在密码提示上**——CI 与本地都跑不通
- **创建 utun 会真改系统路由表**：`auto-route` + `strict-route` 一跑全机流量被接管，测试中途失败就是把开发机网络打断
- **留 root 属主残留**：脚本写的 pid 文件/日志归 root，清理还要再提权一次

这与 `CLAUDE.md`「仅覆盖高危纯函数」的取舍一致。代偿是把实测细节锚在对应函数的头注释里（TUN 判活的 1.2s 窗口、僵尸进程的 `kill -0` 陷阱等），改代码时以注释为准。

### launchd 服务端到端（真装一个服务再停掉）

方向可行且快（一次性 label + shell 桩内核，单轮约 20 秒，用户域全程免 root，v4.7.3 实测验证过），但**有一处抹不掉的痕迹**：`bootstrap`/`bootout` 不写 disabled 表，可一旦测试覆盖 `enable`/`disable`（stop/start 的必经路径，正是最值得测的部分），每个测试 label 都会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 里留一条永久记录——launchctl 没有清除动词，只能 `sudo plutil -remove` 且不立即生效（见「平台假设」）。收益不抵这个代价，故不做。

v4.7.3 的信号死亡实测就是按「一次性 label + 只用 bootstrap/bootout」做的，验证完即清理、disabled 表无残留——需要临时验证 launchd 行为时可复用这个手法，但不固化成测试。

### 已补上的（不需要 sudo 也能测的部分）

共同思路是**让真实的系统工具当裁判**，而非把猜到的行为写死进断言：

- `process-probe.spec.ts`（真实 pgrep 编译 pattern）、`service-exitcode.spec.ts`（真实 launchctl 的 113/112/125 语义与 `waitUntilUnloaded` happy path）、`commands/root-guard.spec.ts`（子进程跑真实入口 + 覆盖 `getuid` 模拟 root）
- `kernel.spec.ts`（真实 release 资产名的变体选择）、`paths.spec.ts`（锁被强夺后释放不误删）、`overwrite.spec.ts`（match 块 fail-closed）、`settings.spec.ts`（settings.json 4 进程并发写不丢条目）
- **`process-stop.spec.ts`（v4.7.3 新增）**：真起桩进程、真 `pkill`，覆盖 `cleanupAll` 单杀/批量分支、`stop` 的 notRunning 语义、`isRunning` 的 PID 复用防线。**无侵入**——`MAIN_INSTANCE_PATTERN` 内嵌 `MIHOMO_CLI_DIR` 的绝对路径，指向 tmpdir 后物理上不可能匹配到 `~/.mihomo-cli` 下用户真在跑的内核，且该前提本身被一条用例断言着（pattern 若改成不含绝对路径，测试当场失败而非静默扩大杀伤范围）

---

## 已验证健壮，无需重查

避免下轮重复排查。每条都实际验证过，不是静态推测。

**并发与数据完整性**
- **锁文件不能放在会被整体删除的目录里**（v4.7.4 修 serviceLock，v4.7.5 补齐其余两把）：`service.lock` 原在 `runtime/` 下，而 `stop()` 的 `clearRuntime()` 与 `reset runtime` 都 `rmrf(DIRS.runtime)`——第三方进程删目录时把别人正持着的锁一起带走，下一个进程立刻 `openSync(...,'wx')` 成功，**两个进程同时进临界区**（实测复现）。`withFileLock` 的 token 所有权校验挡不住：它防的是「被强夺者误删新持有者的锁」，而这里持锁方毫不知情。
  - **v4.7.5 修的同族漏网**：v4.7.4 只移了 `service.lock`，而 `cache.json` 的锁仍在 `subscriptions/cache.json.lock`——`withFileLock` 旧签名收**数据文件**、内部拼 `${filePath}.lock`，锁的位置被数据文件的位置绑死，`reset subs` 的 `rmrf(DIRS.subscriptions)` 照样能把它连目录带走（可达路径：慢速 `sub update` 并行下载逐条回写缓存期间，另一终端 `reset`）。签名已改为收**锁文件本身**，三把锁（`settingsLock`/`subscriptionCacheLock`/`serviceLock`）都是 `PATHS` 里的显式常量、一律在 `USER_DATA_DIR` 根下。
  - **测试断言同步泛化**：`paths.spec.ts` 此前只点名 `PATHS.serviceLock`，所以这个缺口测试测不出来（正是本仓「防线只铺一条路径」的又一例）。现按 `xxxLock` 命名约定枚举 `PATHS` 全部锁，另加一条「枚举数量 ≥ 3」的断言防命名约定被破坏后断言空转成永真，再加一条真跑 `rmrf(DIRS.subscriptions)` 验证缓存锁幸存的回归用例。反向验证过：锁放回旧位置时两条断言都失败。
- 锁的并发正确性：4 进程 × 15 条的 `updateSettings` 并发与 `saveSubscriptionCache` 并发均不丢条目（`settings.spec.ts` 用真实 spawn 子进程验证，必须 spawn 并行起、spawnSync 逐个跑完测不出并发）——规则见 CLAUDE.md「settings.json / cache.json 的读-改-写必须持锁」
- **锁释放校验所有权**（v4.2.3 修）：锁文件写 `pid+hrtime` token，释放前内容一致才删。此前被强夺者的 finally 无条件 rm，删掉的是**新持有者**的锁——三进程实测 B/C 并发 4.6s，正是锁要防的静默丢数据。`paths.spec.ts` 锁定
- 陈旧锁（>10s）会被强夺，一次崩溃不会永久锁死 CLI；实测 0.045s 完成不卡死
- 原子写：临时名带 pid + 进程内自增序号，同进程并发写同一目标不互相踩踏

**YAML 与配置**
- 无原型污染（`__proto__` 只作自有属性）；别名炸弹不放大——解析共享引用，`dumpYaml` 保留锚点，9^7 叶子的归档输出仅 826 字节
- `assertConfigShape` 把 YAML 笔误（列表写成映射、留空行产生 null 元素、`rules` 漏 `-`）转成 `CliError`，不再抛裸 `TypeError` + 堆栈
- 覆写加载顺序确定（显式 sort，`LC_ALL=C` 下一致）
- **match 块加载侧 fail-closed**（v4.2.3 修）：键名打错/值滤空/空对象抛 `CliError`，不再 warn 后静默全局生效——运行侧 `matchesScope` 本就 fail-closed，加载侧降级成「无 match」会让作用域反而扩大到所有订阅（`overwrite.spec.ts` 锁定）
- **`~proxies` patch 已有节点不再误剔除**（v4.2.3 修）：exclude-filter 只收「订阅里没有的名字」，patch 已有节点（本就在池子里）不再把它踢出 include-all 分组（`config.spec.ts` 锁定）
- **TUN 下 `dns.enable` 是系统锁定项**（v4.7.3 修）：订阅/覆写显式 `dns.enable: false` + TUN 曾生成自相矛盾的配置（dns 关着却保留 `dns-hijack`，还往关闭的 dns 块补注 fake-ip 字段）。现强制 `enable: true` 并告警——TUN 劫持 53 端口而内置 DNS 关闭时无组件接管，网络直接不可用；不选「拒绝启动」是因为该值常由机场下发、用户改不了，硬拒绝等于逼用户先会写覆写文件。**只锁 `enable` 一个键**，`nameserver`/`enhanced-mode` 等仍尊重用户值（`config-dns.spec.ts` 锁定）
- **dns 形态校验两条路径共用**（v4.7.3 修）：`assertDnsShape` 收口，TUN 分支读 `enable` 前调、mixed 由 `assertConfigShape` 兜底。此前只有 TUN 有守卫，mixed 下 `dns: true` 一类笔误照样抛裸 TypeError + 堆栈

**进程与状态**
- PID 复用：`isRunning` 与 `cleanupAll` 都走命令行匹配，不裸信 pid 文件
- `MAIN_INSTANCE_PATTERN` 覆盖符号链与真实二进制两种命令行形态，语法为 POSIX ERE，`process-probe.spec.ts` 直接调真实 `pgrep` 编译它（v4.2.0 曾误用 JS 非捕获组导致 pgrep 编译失败、`stop` 不杀内核却报「不在运行」）；pgrep/pkill 退出码只接受 0/1 也已锁定——规则见 CLAUDE.md「pgrep/pkill 的 pattern 必须是 POSIX ERE」
- `killAllMihomo` 同样只接受 pkill 退出码 0/1；批量分支按返回值记 `killedCount`，不再无条件记成全部
- `launchctl` 退出码分级（113 未装载 / 112/125 查询失败）由 `service-exitcode.spec.ts` 调真实 launchctl 锁住——规则见 CLAUDE.md「launchd 服务层」
- **root 守卫**端到端锁住（`commands/root-guard.spec.ts`，含「守卫先于 ensureDirs」）：以 root 运行时域拼成 `gui/0`（不存在），服务操作静默跳过却报成功、KeepAlive 再把内核拉回——规则见 CLAUDE.md「平台与 root 守卫」
- **TUN 与服务共用 config.yaml** 的两层防御均已实现（`mihomo tun` 启动前关自启、`startService` 拒绝 TUN 配置）——机理与规则见 CLAUDE.md「TUN 与服务共用 config.yaml」
- `launchctl print` 解析锚定行首单 tab，`service.spec.ts` 倒序 fixture 锁死（不依赖字段顺序）——规则见 CLAUDE.md「launchd 服务层」
- **信号死亡可见**（v4.7.3 修，v4.7.4 补全第三个消费者）：launchd 对被信号杀死的进程只写 `last terminating signal = Killed: 9`，`last exit code` **整行消失**（实测 macOS 26.6，两字段互斥且不跨 bootstrap 残留；v4.7.4 用一次性 label 再次复现确认）。此前解析器只读退出码，OOM killer / `kill -9` 干掉的内核对 `isCrashed` 与 `status` 完全不可见。v4.7.3 修了 status/doctor 两处，**却漏了 `runtime.assertServiceHealthy`**——那里仍拼 `退出码 ${exitCode}`，信号死亡时 exitCode 为 null，`start`/`install` 期间被 OOM 杀掉的内核显示成「退出码 null」（实测文案已比对）。判据现收口成 `describeExitCause(exitCode, signal)` 一份，三个消费者（`isCrashed` 判有无、`describeAbnormalExit` 供 status/doctor、`assertServiceHealthy` 供 start/install）共用，`service.spec.ts` 直接对判据本身断言并锁住「不能退化成只看退出码」。**教训**：把实测事实锚在注释里挡不住漏铺——注释锚在事实发生处，防线要铺在所有消费处，两者不重合时只有「判据收成一个函数」才真的有效
- **杀进程路径有真实测试**（v4.7.3 新增，见「决策豁免」节）：`process-stop.spec.ts` 真起桩进程、真 `pkill`，覆盖 `cleanupAll` 单杀/批量分支与 `isRunning` 的 PID 复用防线
- **停止/卸载有装载级判定**（v4.2.3 修）：`waitUntilUnloaded` 不再「只等待不判定」——轮询用尽仍装载即抛错，112/125 查询失败也不当「已卸载」；`launchctl disable` 执行后经 `print-disabled` 复核位真生效（TUN 防线第一层的唯一执行点）；uninstall 补上等待 + `rm` 失败可见。v4.2.4 起服务层去 bash 化：用户域 launchctl 全部直接 spawn（不再拼脚本 + 退出码协议），`waitUntilUnloaded` 改为 async 轮询（让出事件循环），happy path 由 `service-exitcode.spec.ts` 只读验证
- **TUN 启动观察满 1.2s 窗口**（v4.2.3 修）：此前 0.4s 单次 `kill -0` 首次存活即收口，且 `kill -0` 对僵尸进程（bash 未收割的已死子进程）也返回成功——判活以 `ps -o stat=` 状态列为准（Z 开头或查不到都算死）；CLI 收口用 `isRunning()` 复核而非纯读 pid 文件
- **install 重装恢复运行走健康确认**（v4.2.3 修）：`wasRunning` 分支 bootstrap 后复用 `assertServiceHealthy`，不再以「bootstrap 没报错」打印「已按原状态重新启动」（v4.2.0 给 start 修的同族缺陷，防线此前只铺了主路径）
- **stop/tun/reset 覆盖遗留 root daemon**（v4.2.3 修）：`detectLegacySystemInstall` 此前只被 install/uninstall/status/reset(checkEmpty) 使用，stop 与 start(tun) 不查——legacy daemon 的 KeepAlive 会把刚杀掉的内核约 10s 拉回，「已停止」成谎报；`reset service` 的 onAfter 也不处理 legacy，报「已重置」原样保留。现在五处统一经 `cleanupLegacyInstallOrThrow()`（含 sudo 取消的 CliError 包装）

**内核下载**
- 来源钉死、curl 全链路强制 https、下载后比对 `asset.size`、自检 `-v` 均已实现——规则见 CLAUDE.md「内核下载的来源信任」
- **`quickstart.sh` 补齐 `asset.size` 比对与 `--max-filesize`**（v4.7.5）：这两道 CLI 侧早有的防线在脚本里缺着，是第三次被人肉发现的平行实现漂移（前两次是安全水位、资产选择形态）。脚本侧的 size 依赖 jq（取不到即留空跳过比对，不阻断下载），属能力差异而非水位差异。用真实 GitHub API 响应验证过提取与 `max-filesize` 计算，以及资产名不匹配时安全留空
- **多通道下载**（v4.7.0）：四通道（gh/本机代理/镜像/直连）均过端到端实测（隔离目录各下载一次真实内核），`resolveDownloadChannel` 优先级矩阵有单测——规则见 CLAUDE.md「内核下载的来源信任」
- **资产选择精确匹配标准版形态**（`kernel.spec.ts` 用 v1.19.30 真实资产名锁定）：v4.2.3 前漏了 `-v1/-v2/-v3` GOAMD64 变体，Intel Mac 每次更新静默装上 baseline 构建——规则见 CLAUDE.md「内核下载的来源信任」
- **全预发布时不回退**（v4.7.3 修）：`pickLatestRelease` 此前 fallback `releases[0]`，页内全是 alpha 时会把 alpha 当稳定版装上。今日不可达（上游同时只挂一条 alpha），属防御性——内核以 root 跑（TUN）或长期常驻，静默降级到未发布版本不可接受，现直接抛错
- tar 双守卫（路径穿越 + 条目类型）：攻击归档实测被挡下、正常归档不误拒——规则见 CLAUDE.md「内核下载的来源信任」
- 上游确无 checksums（127 个资产实测），故无法做哈希校验——别再提议加

**命令行与错误处理**
- flag 单表派生（`src/flags.ts` → `VALUE_FLAGS` 与 start 重启透传集合）——规则与旧设计教训见 CLAUDE.md「命令行选项」
- 非 TTY 退出码：`reset` 与 `sub remove` 模糊匹配都正确抛 `CliError` 退 1——规则见 CLAUDE.md「交互确认与退出码」
- 已移除的选项/命令（`--no-ssh`、`--mirror-all`、`daemon`/`up`/`down`）均显式报错并给迁移指引——规则见 CLAUDE.md「命令行选项」与「服务模型的既定决策」
- HTTP 超时覆盖响应体读取（abort 中断流）；错误体限量 64KB 读取
- **`reset` 不再重建刚删掉的 settings.json**（v4.7.5 修）：`overwrites` 的 `onAfter` 调 `writeSettings`，却排在 `settings` **之后**——`reset --full` 报「已重置: 设置」而磁盘上留着 `{"overwrite_enabled": false}`（实测复现）。伤害不止于谎报：全新数据目录的覆写默认是**启用**，于是用户重置后重新放 `overwrite.yaml`，覆写静默不生效且毫无线索。此前 `reset.spec.ts` 只点名断言了 `subs`（同族的另一个写 settings 的目标），`overwrites` 因此躺在盲区——现按 `WRITES_SETTINGS_ON_AFTER` 清单遍历断言，另加两条**端到端**断言（真跑 `reset --full` 查磁盘状态与 `isOverwriteEnabled()`），后者不依赖清单正确性：清单漏登记时顺序断言空过，端到端断言仍会失败。反向验证过：在 main 的实现上三条断言全部失败
- **归档日志的文件名判据收成一份**（v4.7.5 修）：`cleanupOldLogs` 与 `listLogs` 各写一份正则，只有前者认序号后缀 `mihomo.<ts>.N.log`——那些归档被按时清理却**永不出现在 `logs` 列表**，`logs <编号>` 取不到（实测：造两个同秒归档，带序号那个列不出来）。而序号后缀恰产生于「同秒二次轮转」，即 start 失败后立即重试这个最需要翻日志的场景。判据现为 `isArchiveLogFilename`，归档路径分配也收口成 `allocateArchivePath()`（`rotateLog` 的 rename 与 `restartService` 的 copy-truncate 共用）——规则见 CLAUDE.md「归档日志的文件名判据只有一份」

**已删除的过度设计**（v4.7.5，别再加回来）
- **`parseYamlOrJson` 的 JSON 回退分支**：YAML 1.2 是 JSON 超集，实测标准 JSON、tab 缩进 JSON、长整数全部由 `loadYamlSafe` 正常解析。唯一能走到 `JSON.parse` 的输入是**重复键 JSON**（YAML 报错，JSON.parse 静默取最后一个值）——那条回退把「坏数据」变成「静默接受」，方向正好相反。现更名 `parseConfigContent`、只走 YAML，并把解析器的行列号带进错误消息（实测 `duplicated mapping key (1:9)`）。`config.spec.ts` 锁住「JSON 输入仍能解析」，防有人以为需要把回退加回来
- **三份镜像清单**：`AVAILABLE_MIRRORS`（展示，手写域名）、`MIRROR_ALIASES`（解析，手写地址）、`getDefaultMirror` 里硬编码的裸域，增删镜像要改三处且无兜底（漏改别名表是「别名直接不认」）。现全部从 `MIRROR_HOST` + `MIRROR_ALIASES` 派生，`utils.spec.ts` 有派生关系断言（别名主机名必在展示清单内、清单项必是同一主机的裸域或子域、地址一律 https 且以 `/` 结尾）
- **`openUrl` 的 boolean 返回值**：`open` 是 detached spawn，失败全发生在函数返回之后（只能被 `child.on('error')` 吞掉），故它**恒返回 true**，四个调用点的 `if (!success) 请手动打开…` 全是死代码，还让人误以为失败能被检出。改为 `void` 返回，调用方一律无条件打印地址/路径（`dir open` 顺带把路径打出来了，此前只有标签）。要真检出失败得换 `spawnSync` + 解析退出码，为一个非阻塞的顺手操作引入同步等待不值得——**这是刻意选择不检出**

---

## 平台假设

macOS 硬依赖，无其他平台后端：

- **launchd 整套**：`~/Library/LaunchAgents`、plist XML（`RunAtLoad`/`KeepAlive`）、`launchctl bootout/bootstrap/kickstart/enable/disable/print`
- **`kickstart -k` 阻塞等进程死亡**（v4.2.4 实测）：对不立即响应 SIGTERM 的进程可超过 5s——不能用查询类命令的 5s 超时，`restartService` 单独放宽到 60s（与旧 bash 脚本的整体超时一致）。`bootout` 对未装载目标返回 **3**（"No such process"），不是 113；`enable`/`disable` 对未装载 label 也返回 0 并写 disabled 表
- **`KeepAlive.PathState` 不能用来实现 stop**（实测排除的设计方案）：删掉 flag 文件后进程照跑不误，`KeepAlive` 只决定「退出后是否重启」，不主动终止运行中的任务。这条排除了「flag 文件 + root daemon 免密」的方案
- **手工抹掉 disable 记录的流程**（仅供开发期收尾，不能做进 CLI 自动清理）：disable 位持久化在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist`，launchctl 没有「清除记录」的动词，`enable` 同样写一条 `=> enabled`。要真正抹掉只能 `sudo plutil -remove` 删键——**keypath 里 `.` 是层级分隔符，label 必须转义成 `com\.foo\.bar`**。且 launchd 在内存里持有该表，改磁盘不触发重读，`print-disabled` 仍显示旧值，重启后才一致（既要提权又不立即生效，故只作手工收尾）
- **`spawn('open', ...)`**：`open.ts` 单点收口，返回 `void`——`child.on('error', () => {})` 吞掉 ENOENT，失败在函数返回后才发生，本就无从检出（v4.7.5 起不再假装能检出，见「已删除的过度设计」）。Debian 的 `/usr/bin/open` 指向 `run-mailcap`，会把 URL 当 MIME 附件处理——属主动做错
- **BSD 专有语法**：`stat -f%z`（GNU 为 `-c%s`）、`ps -o command=`（必须带 `-ww`，见 `CLAUDE.md`）、`tail`
- `sudo`、`pgrep`/`pkill`、生成的 `#!/bin/bash` 脚本

守卫：`package.json` 的 `"os": ["darwin"]` + `index.ts` `main()` 开头的平台校验（豁免 `help`/`version`，留 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 逃生阀，**必须先于 `ensureDirs`** 以免在不支持的平台污染家目录）。

**已可移植**（改动时别破坏）：`kernel.ts` 的资产选择用真实 `process.platform` + arch 映射，无硬编码 darwin；全部用户数据路径经 `os.homedir()` + `path.join`；**零网络重配**（`networksetup`/`scutil`/`route`/`pfctl` 全零命中），TUN 路由完全委托内核。

---

## 工程

- 单测 310（`npm test`，经 tsx 跑 `*.spec.ts`）
- `prepublishOnly: npm run build`：`dist/` 被 gitignore，漏跑 build 即发布陈旧产物。**它只保证 build 跑过，不保证 tarball 里的东西对**——版本号、`files` 字段任一出错 `npm publish` 都照样成功，故 publish 前至少 `node dist/index.js version` 自检一次（流程见 `/release` 的「产物自检」）
- v4.7.5 起发布后会从 registry 拉回产物实跑本轮修的行为。验证锁位置时注意：**锁文件正常释放后即删，静态 `ls` 看不到**，要在持锁期间高频扫描才能观察到落点
