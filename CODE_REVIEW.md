# 代码审查：风险与教训

> 当前基线：v4.2.2
> 上次全面审查：2026-09-05

**这份文档只记录两类内容**：本轮发现的未处理项，以及**验证过、下轮不必重查**的结论。

已修复条目不在此长期留存——它们的教训该提炼进 `CLAUDE.md` 的对应小节（那里是干活时会读的地方），修复细节留在 `CHANGELOG.md` 与 git 历史里。此前本文积累了 v3.6.0/v3.8.0 两轮的逐项修复清单共 24+10 条，其中涉及已删除功能（ssh 隧道、节点测速、多源合并订阅）的条目占了近三分之一，复核时才发现「记录属实但代码已不存在」——这种维护成本没有对应收益，故不再保留。

**维护约定**：
- 结论要给复现步骤，不要静态推测
- 改动涉及本文条目时同步更新
- 下轮审查前先复核「未处理项」，不要直接沿用

---

## 未处理项

### 覆盖面：跑 sudo 与杀进程的代码单测仍稀疏

`process-start.ts` / `process-stop.ts` / `service.ts` 的副作用路径（sudo 脚本、实际的 pkill、launchctl 写操作）仍没有自动化测试。这是 `CLAUDE.md` 明确的取舍（「仅覆盖高危纯函数」），但值得记录：v4.2.0 修的两个高危（启动误报、日志不轮转）都是靠手工搭隔离环境才发现的。

v4.2.1/v4.2.2 已补上三处**不需要 sudo 也能测**的：`process-probe.spec.ts`（真实 pgrep 编译 pattern）、`service-exitcode.spec.ts`（真实 launchctl 的 113/112/125 语义）、`commands/root-guard.spec.ts`（子进程跑真实入口 + 覆盖 `getuid` 模拟 root）。共同思路是**让真实的系统工具当裁判**，而非把猜到的行为写死进断言。

仍缺的是「真的起一个服务再停掉」这类端到端流程。方向是「用一次性 label 装一个假内核（shell 脚本桩），跑真实 launchctl」——本轮验证 KeepAlive 重启行为时的临时脚本证明这条路可行且快（单轮约 20 秒，全程用户域免 root），但要解决「测试失败时确保 bootout + 删 plist」的清理保证。

### 观察窗之后才崩溃的内核判不出来

`waitServiceHealthy` 只覆盖「启动后立即退出」（配置解析失败的典型形态）。跑了几秒才 OOM 或 panic 的内核，`start` 仍会报成功——由 `status` 的「上次异常退出」提示兜底。这是有意的边界：要覆盖它就得让 `start` 挂在那儿等更久，代价不划算。

---

## 已验证健壮，无需重查

避免下轮重复排查。每条都实际验证过，不是静态推测。

**并发与数据完整性**
- `settings.json` / `cache.json` 的读-改-写全部持 `withFileLock`；6 并发 `sub add` 不丢条目，4 进程各写 30 条缓存不丢条目（`settings.spec.ts` 用真实子进程验证）
- 陈旧锁（>10s）会被强夺，一次崩溃不会永久锁死 CLI；实测 0.045s 完成不卡死
- 原子写：临时名带 pid + 进程内自增序号，同进程并发写同一目标不互相踩踏

**YAML 与配置**
- 无原型污染（`__proto__` 只作自有属性）；别名炸弹不放大——解析共享引用，`dumpYaml` 保留锚点，9^7 叶子的归档输出仅 826 字节
- `assertConfigShape` 把 YAML 笔误（列表写成映射、留空行产生 null 元素、`rules` 漏 `-`）转成 `CliError`，不再抛裸 `TypeError` + 堆栈
- 覆写加载顺序确定（显式 sort，`LC_ALL=C` 下一致）

**进程与状态**
- PID 复用：`isRunning` 与 `cleanupAll` 都走命令行匹配，不裸信 pid 文件
- `MAIN_INSTANCE_PATTERN` 覆盖符号链与真实二进制两种命令行形态，且**语法为 POSIX ERE**——`process-probe.spec.ts` 直接调真实 `pgrep` 编译它。v4.2.0 曾误用 JS 非捕获组 `(?:a|b)`，pgrep 编译失败退 2、无输出，被 `getMihomoPids` 吞成「没有进程」，导致 `stop` 不杀内核却报「不在运行」（v4.2.1 修）
- `getMihomoPids` 对 `pgrep` 退出码只接受 0/1，其余抛 `CliError`：探测失败不得伪装成「没有进程」
- `killAllMihomo` 同样只接受 pkill 退出码 0/1；批量分支按返回值记 `killedCount`，不再无条件记成全部
- `launchctl` 退出码分级：只有 `113` 是「未装载」，`112`/`125` 为查询失败并抛错（`service-exitcode.spec.ts` 调真实 launchctl 锁住）
- **root 守卫**：`sudo mihomo` 被入口拒绝。以 root 运行时域拼成 `gui/0`（不存在），所有服务操作静默跳过却报成功，随后 KeepAlive 拉回内核（`commands/root-guard.spec.ts` 端到端锁住，含「守卫先于 ensureDirs」）
- **TUN 与服务共用 config.yaml**：`mihomo tun` 启动前关掉服务自启，`startService` 拒绝 TUN 配置。否则 TUN 未停就关机时，重启后 LaunchAgent 会以普通用户身份拿 TUN 配置反复拉起注定失败的内核
- `launchctl print` 解析锚定行首单 tab，`service.spec.ts` 用倒序 fixture 锁死（不依赖 launchd 的字段顺序）

**内核下载**
- 来源钉死（host 白名单 + 强制 https + 校验在加镜像前缀之前）、curl 全链路强制 https、下载后比对 `asset.size`、自检 `-v`
- tar 双守卫（路径穿越 + 条目类型），攻击归档实测被挡下且正常归档不误拒
- 上游确无 checksums（127 个资产实测），故无法做哈希校验——别再提议加

**命令行与错误处理**
- 两张 flag 表无漂移：带值选项全在 `VALUE_FLAGS`，`cmdStart` 的布尔选项全在 `BOOL_FLAGS`
- 非 TTY 退出码：`reset` 与 `sub remove` 模糊匹配都正确抛 `CliError` 退 1
- 已移除的选项/命令（`--no-ssh`、`--mirror-all`、`daemon`/`up`/`down`）均显式报错并给迁移指引，不静默按默认行为继续
- HTTP 超时覆盖响应体读取（abort 中断流）；错误体限量 64KB 读取

---

## 平台假设

macOS 硬依赖，无其他平台后端：

- **launchd 整套**：`~/Library/LaunchAgents`、plist XML（`RunAtLoad`/`KeepAlive`）、`launchctl bootout/bootstrap/kickstart/enable/disable/print`
- **`spawn('open', ...)`**：`open.ts` 单点收口。注意 `child.on('error', () => {})` 吞掉 ENOENT 后 `openUrl` **恒返回 true**，调用方的 `if (!success) 请手动打开…` 在非 macOS 上是死代码；Debian 的 `/usr/bin/open` 指向 `run-mailcap`，会把 URL 当 MIME 附件处理——属主动做错
- **BSD 专有语法**：`stat -f%z`（GNU 为 `-c%s`）、`ps -o command=`（必须带 `-ww`，见 `CLAUDE.md`）、`tail`
- `sudo`、`pgrep`/`pkill`、生成的 `#!/bin/bash` 脚本

守卫：`package.json` 的 `"os": ["darwin"]` + `index.ts` `main()` 开头的平台校验（豁免 `help`/`version`，留 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 逃生阀，**必须先于 `ensureDirs`** 以免在不支持的平台污染家目录）。

**已可移植**（改动时别破坏）：`kernel.ts` 的资产选择用真实 `process.platform` + arch 映射，无硬编码 darwin；全部用户数据路径经 `os.homedir()` + `path.join`；**零网络重配**（`networksetup`/`scutil`/`route`/`pfctl` 全零命中），TUN 路由完全委托内核。

---

## 工程

- 单测 178（`npm test`，经 tsx 跑 `*.spec.ts`）
- CI 在 `macos-latest` 上跑 typecheck/check/test/build。因 `os: ["darwin"]`，ubuntu runner 上 `npm ci` 会平台不匹配失败
- `prepublishOnly: npm run build`：`dist/` 被 gitignore，漏跑 build 即发布陈旧产物
- **`npm run check` 在 worktree 里是空转**：`biome.json` 的 `files.includes` 排除 `**/.claude`，而 worktree 建在 `.claude/worktrees/` 下，于是「Checked 0 files」直接通过。worktree 中改完要显式跑 `npx biome check src/`
