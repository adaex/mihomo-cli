# 代码审查：风险与教训

> 当前基线：v4.6.0
> 上次全面审查：2026-09-05（本轮：3 个维度并行扫描全部 src + 独立交叉验证，修复 30 项，见 CHANGELOG v4.6.0）

**这份文档只记录两类内容**：本轮发现的未处理项，以及**验证过、下轮不必重查**的结论。

已修复条目不在此长期留存——规则类教训提炼进 `CLAUDE.md` 的「工作规则」，事故的实测细节锚进对应代码的函数头注释（co-located、随代码 review），修复细节留在 `CHANGELOG.md` 与 git 历史里。此前本文积累了 v3.6.0/v3.8.0 两轮的逐项修复清单共 24+10 条，其中涉及已删除功能（ssh 隧道、节点测速、多源合并订阅）的条目占了近三分之一，复核时才发现「记录属实但代码已不存在」——这种维护成本没有对应收益，故不再保留。

**维护约定**：
- 结论要给复现步骤，不要静态推测
- 改动涉及本文条目时同步更新
- 下轮审查前先复核「未处理项」，不要直接沿用

---

## 未处理项

### 覆盖面：跑 sudo 与杀进程的代码单测仍稀疏

`process-start.ts` / `process-stop.ts` / `service.ts` 的副作用路径（sudo 脚本、实际的 pkill、launchctl 写操作）仍没有自动化测试。这是 `CLAUDE.md` 明确的取舍（「仅覆盖高危纯函数」），但值得记录：v4.2.0 修的两个高危（启动误报、日志不轮转）都是靠手工搭隔离环境才发现的。

v4.2.1/v4.2.2 已补上三处**不需要 sudo 也能测**的：`process-probe.spec.ts`（真实 pgrep 编译 pattern）、`service-exitcode.spec.ts`（真实 launchctl 的 113/112/125 语义）、`commands/root-guard.spec.ts`（子进程跑真实入口 + 覆盖 `getuid` 模拟 root）。共同思路是**让真实的系统工具当裁判**，而非把猜到的行为写死进断言。

v4.2.3 又补四处：`kernel.spec.ts`（真实 release 资产名的变体选择）、`paths.spec.ts`（锁被强夺后释放不误删）、`overwrite.spec.ts`（match 块 fail-closed）、`settings.spec.ts`（settings.json 4 进程并发写不丢条目——此前 CODE_REVIEW 声称有此测试、实际不存在，已补齐使声称成真）。

v4.2.4 服务层去 bash 化后，`waitUntilUnloaded` 的未装载 happy path 也收进 `service-exitcode.spec.ts`（真实 launchctl、只读）——此前这段逻辑是 bash 脚本里的 while 循环，完全不可测。

### TUN 模式尊重 `dns.enable: false` 却保留 dns-hijack（v4.2.3 发现，未修）

订阅/覆写显式 `dns.enable: false`（mixed 场景合法）+ `mihomo tun`：生成 `dns: {enable: false, ...}` 同时保留 `tun.dns-hijack: [any:53, tcp://any:53]`，还向已关闭的 dns 块补注 fake-ip 字段（实测，生成端矛盾确定；内核侧确切行为未验证）。修复方向是语义决策：TUN 模式把 `dns.enable` 视为锁定项强制 true，或显式拒绝这个组合——待定。

### 服务操作无跨进程串行化（v4.2.3 发现，v4.6.0 已修）

~~settings.json 有 `withFileLock`，launchd 服务操作没有~~ → v4.6.0 已修：`startService`/`stopService`/`installService`/`uninstallService` 的 enable/bootstrap/bootout/disable 共持 `service.lock`，start 在锁内再查 disabled 防「stop 在等待期间已跑完」

### 低优先级未处理（v4.2.3 扫描发现，影响面小）

- ~~`start`/`logs`/`ow`/`sub` 不校验未知 flag~~ → v4.6.0 已修：`assertKnownFlags` 通用校验
- ~~`update` 当前版本领先 registry latest 时静默降级~~ → v4.6.0 已修：`compareVersions` 比对，领先时跳过
- `getLatestRelease` 页内全是预发布时 fallback `releases[0]` 会把 alpha 当稳定版返回（今日不可达：上游同时只挂一条 alpha）
- 信号死亡的内核对 `isCrashed`/`status` 不可见：launchd 写 `last terminating signal = Killed: 9` 而非 `last exit code`（实测确认），解析器读不到——错误提示会指向相反方向
- ~~`sub add` 切换默认订阅后运行中实例零提示~~ → v4.6.0 已修：补 `printRestartHintIfRunning`
- TUN dns 为非映射值时已转 `CliError`（v4.2.3 顺手修），但 `assertConfigShape` 仍不校验 dns 形态（mixed 路径无此守卫）

仍缺的是「真的起一个服务再停掉」这类端到端流程。方向是「用一次性 label 装一个假内核（shell 脚本桩），跑真实 launchctl」——本轮验证 KeepAlive 重启行为时的临时脚本证明这条路可行且快（单轮约 20 秒，全程用户域免 root），但要解决「测试失败时确保 bootout + 删 plist」的清理保证。

### 观察窗之后才崩溃的内核判不出来

`waitServiceHealthy` 只覆盖「启动后立即退出」（配置解析失败的典型形态）。跑了几秒才 OOM 或 panic 的内核，`start` 仍会报成功——由 `status` 的「上次异常退出」提示兜底。这是有意的边界：要覆盖它就得让 `start` 挂在那儿等更久，代价不划算。

---

## 已验证健壮，无需重查

避免下轮重复排查。每条都实际验证过，不是静态推测。

**并发与数据完整性**
- `settings.json` / `cache.json` 的读-改-写全部持 `withFileLock`；4 进程 × 15 条的 `updateSettings` 并发与 `saveSubscriptionCache` 并发均不丢条目（`settings.spec.ts` 用真实 spawn 子进程验证，必须 spawn 并行起、spawnSync 逐个跑完测不出并发）
- **锁释放校验所有权**（v4.2.3 修）：锁文件写 `pid+hrtime` token，释放前内容一致才删。此前被强夺者的 finally 无条件 rm，删掉的是**新持有者**的锁——三进程实测 B/C 并发 4.6s，正是锁要防的静默丢数据。`paths.spec.ts` 锁定
- 陈旧锁（>10s）会被强夺，一次崩溃不会永久锁死 CLI；实测 0.045s 完成不卡死
- 原子写：临时名带 pid + 进程内自增序号，同进程并发写同一目标不互相踩踏

**YAML 与配置**
- 无原型污染（`__proto__` 只作自有属性）；别名炸弹不放大——解析共享引用，`dumpYaml` 保留锚点，9^7 叶子的归档输出仅 826 字节
- `assertConfigShape` 把 YAML 笔误（列表写成映射、留空行产生 null 元素、`rules` 漏 `-`）转成 `CliError`，不再抛裸 `TypeError` + 堆栈
- 覆写加载顺序确定（显式 sort，`LC_ALL=C` 下一致）
- **match 块加载侧 fail-closed**（v4.2.3 修）：键名打错/值滤空/空对象抛 `CliError`，不再 warn 后静默全局生效——运行侧 `matchesScope` 本就 fail-closed，加载侧降级成「无 match」会让作用域反而扩大到所有订阅（`overwrite.spec.ts` 锁定）
- **`~proxies` patch 已有节点不再误剔除**（v4.2.3 修）：exclude-filter 只收「订阅里没有的名字」，patch 已有节点（本就在池子里）不再把它踢出 include-all 分组（`config.spec.ts` 锁定）

**进程与状态**
- PID 复用：`isRunning` 与 `cleanupAll` 都走命令行匹配，不裸信 pid 文件
- `MAIN_INSTANCE_PATTERN` 覆盖符号链与真实二进制两种命令行形态，且**语法为 POSIX ERE**——`process-probe.spec.ts` 直接调真实 `pgrep` 编译它。v4.2.0 曾误用 JS 非捕获组 `(?:a|b)`，pgrep 编译失败退 2、无输出，被 `getMihomoPids` 吞成「没有进程」，导致 `stop` 不杀内核却报「不在运行」（v4.2.1 修）
- `getMihomoPids` 对 `pgrep` 退出码只接受 0/1，其余抛 `CliError`：探测失败不得伪装成「没有进程」
- `killAllMihomo` 同样只接受 pkill 退出码 0/1；批量分支按返回值记 `killedCount`，不再无条件记成全部
- `launchctl` 退出码分级：只有 `113` 是「未装载」，`112`/`125` 为查询失败并抛错（`service-exitcode.spec.ts` 调真实 launchctl 锁住）
- **root 守卫**：`sudo mihomo` 被入口拒绝。以 root 运行时域拼成 `gui/0`（不存在），所有服务操作静默跳过却报成功，随后 KeepAlive 拉回内核（`commands/root-guard.spec.ts` 端到端锁住，含「守卫先于 ensureDirs」）
- **TUN 与服务共用 config.yaml**：`mihomo tun` 启动前关掉服务自启，`startService` 拒绝 TUN 配置。否则 TUN 未停就关机时，重启后 LaunchAgent 会以普通用户身份拿 TUN 配置反复拉起注定失败的内核
- `launchctl print` 解析锚定行首单 tab，`service.spec.ts` 用倒序 fixture 锁死（不依赖 launchd 的字段顺序）
- **停止/卸载有装载级判定**（v4.2.3 修）：`waitUntilUnloaded` 不再「只等待不判定」——轮询用尽仍装载即抛错，112/125 查询失败也不当「已卸载」；`launchctl disable` 执行后经 `print-disabled` 复核位真生效（TUN 防线第一层的唯一执行点）；uninstall 补上等待 + `rm` 失败可见。v4.2.4 起服务层去 bash 化：用户域 launchctl 全部直接 spawn（不再拼脚本 + 退出码协议），`waitUntilUnloaded` 改为 async 轮询（让出事件循环），happy path 由 `service-exitcode.spec.ts` 只读验证
- **TUN 启动观察满 1.2s 窗口**（v4.2.3 修）：此前 0.4s 单次 `kill -0` 首次存活即收口，且 `kill -0` 对僵尸进程（bash 未收割的已死子进程）也返回成功——判活以 `ps -o stat=` 状态列为准（Z 开头或查不到都算死）；CLI 收口用 `isRunning()` 复核而非纯读 pid 文件
- **install 重装恢复运行走健康确认**（v4.2.3 修）：`wasRunning` 分支 bootstrap 后复用 `assertServiceHealthy`，不再以「bootstrap 没报错」打印「已按原状态重新启动」（v4.2.0 给 start 修的同族缺陷，防线此前只铺了主路径）
- **stop/tun/reset 覆盖遗留 root daemon**（v4.2.3 修）：`detectLegacySystemInstall` 此前只被 install/uninstall/status/reset(checkEmpty) 使用，stop 与 start(tun) 不查——legacy daemon 的 KeepAlive 会把刚杀掉的内核约 10s 拉回，「已停止」成谎报；`reset service` 的 onAfter 也不处理 legacy，报「已重置」原样保留。现在五处统一经 `cleanupLegacyInstallOrThrow()`（含 sudo 取消的 CliError 包装）

**内核下载**
- 来源钉死（host 白名单 + 强制 https + 校验在加镜像前缀之前）、curl 全链路强制 https、下载后比对 `asset.size`、自检 `-v`
- **资产选择精确匹配标准版形态**（v4.2.3 修）：`mihomo-<platform>-<arch>-vX.Y.Z` 收尾。此前只黑名单 `-go`/`-compatible`，漏了 `-v1/-v2/-v3` GOAMD64 微架构变体——它们同样以版本号结尾，且名称排序 `-`<`.` 使 `-v1` 变体排在标准版前被优先选中，Intel Mac 每次更新都静默装上 baseline 构建（`kernel.spec.ts` 用 v1.19.30 真实资产名锁定）
- tar 双守卫（路径穿越 + 条目类型），攻击归档实测被挡下且正常归档不误拒
- 上游确无 checksums（127 个资产实测），故无法做哈希校验——别再提议加

**命令行与错误处理**
- flag 登记表无漂移：`src/flags.ts` 单表派生 `VALUE_FLAGS` 与 start 重启透传集合（v4.2.4 起；此前是 utils.ts 两张硬编码表，漏登记即静默失效）
- 非 TTY 退出码：`reset` 与 `sub remove` 模糊匹配都正确抛 `CliError` 退 1
- 已移除的选项/命令（`--no-ssh`、`--mirror-all`、`daemon`/`up`/`down`）均显式报错并给迁移指引，不静默按默认行为继续
- HTTP 超时覆盖响应体读取（abort 中断流）；错误体限量 64KB 读取

---

## 平台假设

macOS 硬依赖，无其他平台后端：

- **launchd 整套**：`~/Library/LaunchAgents`、plist XML（`RunAtLoad`/`KeepAlive`）、`launchctl bootout/bootstrap/kickstart/enable/disable/print`
- **`kickstart -k` 阻塞等进程死亡**（v4.2.4 实测）：对不立即响应 SIGTERM 的进程可超过 5s——不能用查询类命令的 5s 超时，`restartService` 单独放宽到 60s（与旧 bash 脚本的整体超时一致）。`bootout` 对未装载目标返回 **3**（"No such process"），不是 113；`enable`/`disable` 对未装载 label 也返回 0 并写 disabled 表
- **`KeepAlive.PathState` 不能用来实现 stop**（实测排除的设计方案）：删掉 flag 文件后进程照跑不误，`KeepAlive` 只决定「退出后是否重启」，不主动终止运行中的任务。这条排除了「flag 文件 + root daemon 免密」的方案
- **手工抹掉 disable 记录的流程**（仅供开发期收尾，不能做进 CLI 自动清理）：disable 位持久化在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist`，launchctl 没有「清除记录」的动词，`enable` 同样写一条 `=> enabled`。要真正抹掉只能 `sudo plutil -remove` 删键——**keypath 里 `.` 是层级分隔符，label 必须转义成 `com\.foo\.bar`**。且 launchd 在内存里持有该表，改磁盘不触发重读，`print-disabled` 仍显示旧值，重启后才一致（既要提权又不立即生效，故只作手工收尾）
- **`spawn('open', ...)`**：`open.ts` 单点收口。注意 `child.on('error', () => {})` 吞掉 ENOENT 后 `openUrl` **恒返回 true**，调用方的 `if (!success) 请手动打开…` 在非 macOS 上是死代码；Debian 的 `/usr/bin/open` 指向 `run-mailcap`，会把 URL 当 MIME 附件处理——属主动做错
- **BSD 专有语法**：`stat -f%z`（GNU 为 `-c%s`）、`ps -o command=`（必须带 `-ww`，见 `CLAUDE.md`）、`tail`
- `sudo`、`pgrep`/`pkill`、生成的 `#!/bin/bash` 脚本

守卫：`package.json` 的 `"os": ["darwin"]` + `index.ts` `main()` 开头的平台校验（豁免 `help`/`version`，留 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 逃生阀，**必须先于 `ensureDirs`** 以免在不支持的平台污染家目录）。

**已可移植**（改动时别破坏）：`kernel.ts` 的资产选择用真实 `process.platform` + arch 映射，无硬编码 darwin；全部用户数据路径经 `os.homedir()` + `path.join`；**零网络重配**（`networksetup`/`scutil`/`route`/`pfctl` 全零命中），TUN 路由完全委托内核。

---

## 工程

- 单测 203（`npm test`，经 tsx 跑 `*.spec.ts`）
- CI 在 `macos-latest` 上跑 typecheck/check/test/build。因 `os: ["darwin"]`，ubuntu runner 上 `npm ci` 会平台不匹配失败
- `prepublishOnly: npm run build`：`dist/` 被 gitignore，漏跑 build 即发布陈旧产物
- **`npm run check` 在 worktree 里是空转**：`biome.json` 的 `files.includes` 排除 `**/.claude`，而 worktree 建在 `.claude/worktrees/` 下，于是「Checked 0 files」直接通过。worktree 中改完要显式跑 `npx biome check src/`
