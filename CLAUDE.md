# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## 项目概述

- **语言**: TypeScript (ESM)
- **入口**: `src/index.ts`
- **构建**: `tsup` → `dist/index.js` (单文件打包)
- **开发运行**: `tsx src/index.ts`
- **别名**: `mihomo` (推荐), `mhm`, `mh`, `mihomo-cli`
- **运行时**: Node.js >= 22.22.1（`engines` 声明的最低运行版本；`@types/node`/`typescript` 跟随最新，故类型面版本高于运行时下限，属有意为之）

---

## 架构

| 模块                       | 职责                              |
| -------------------------- | --------------------------------- |
| `src/index.ts`             | main()、信号处理、从注册表分发命令 |
| `src/types.ts`             | 所有类型定义（集中管理）          |
| `src/constants.ts`         | 默认配置、UI URLs、镜像列表、控制器地址、VERSION/PKG_NAME |
| `src/utils.ts`             | 纯函数小工具：sleep、escapeRegExp/shellQuote、格式化、显示宽度、flag 解析、did-you-mean |
| `src/colors.ts`            | 颜色与 NO_COLOR                   |
| `src/errors.ts`            | CliError、TimeoutError、withTimeout |
| `src/flags.ts`             | 选项登记单一 `FLAGS` 表，派生 `VALUE_FLAGS` 与 start 重启透传集合 |
| `src/http.ts`              | HTTP 客户端（超时、响应体大小上限） |
| `src/paths.ts`             | 路径常量、目录管理、原子写、跨进程锁 |
| `src/settings.ts`          | settings.json 读写（含损坏恢复）、订阅缓存、订阅列表增删、URL 遮蔽 |
| `src/config.ts`            | 配置构建、YAML 解析/序列化、内核版本 |
| `src/subscription.ts`      | 订阅下载、流量解析、自动更新      |
| `src/process-probe.ts`     | 进程探测：ps/pgrep、pid 文件、运行状态、getStatus |
| `src/proxy-probe.ts`       | 代理连通性探测（curl 经本机混合端口访问 gstatic generate_204） |
| `src/process-start.ts`     | TUN 内核启动（sudo 脚本）。Mixed 无用户态路径，由 service.ts 托管 |
| `src/process-stop.ts`      | 内核停止/清理：stop、cleanupAll、clearPid |
| `src/log-files.ts`         | 日志轮转/清理/列表/路径、归档名判据与路径分配（清理与列表共用）、readLogTail（启动失败时附给用户的线索） |
| `src/open.ts`              | openUrl/openLogFile/viewLogWithTail |
| `src/spinner.ts`           | withSpinner：长操作的等待反馈（TTY 转圈动画，非 TTY 降级为一行） |
| `src/sudo.ts`              | runSudoScript：TUN 与清理遗留 root 服务共用的 sudo 脚本范式 |
| `src/service.ts`           | launchd 服务（用户级 LaunchAgent，全程免密）：install/start/stop/uninstall、启动健康确认、热重载、状态查询、符号链、遗留 root 安装的识别与清理 |
| `src/runtime.ts`           | 运行时门面：收敛 service(Mixed)/tun 双轨（模式、状态、启停、启动结果校验） |
| `src/lifecycle.ts`         | 静默 SIGINT 标志（tail -f 场景下 Ctrl+C 不打印「正在退出」） |
| `src/kernel.ts`            | GitHub Releases 检查、多通道下载（gh/本机代理/镜像/直连） |
| `src/overwrite.ts`         | 覆写配置合并                      |
| `src/commands/registry.ts` | 命令注册表（name/别名/handler/argv 改写/help 用法），路由与帮助的单一真相源 |
| `src/commands/shared.ts`   | 命令层公共工具：dispatchSubcommand 子命令分发、confirmPrompt/confirmOrThrow、restartToApply |
| `src/commands/*.ts`        | 各命令处理器（每命令一个文件）    |

### 命令处理器

| 文件                          | 命令                           |
| ----------------------------- | ------------------------------ |
| `commands/help.ts`            | help, version, 简短帮助       |
| `commands/status.ts`          | status                         |
| `commands/start.ts`           | start, tun                     |
| `commands/removed.ts`         | 已移除命令的墓碑（daemon/up/down）|
| `commands/stop.ts`            | stop（停止 + 关闭自启）        |
| `commands/log.ts`             | logs（`log` 为隐藏别名，等价 `logs 0 -f`） |
| `commands/ui.ts`              | ui                             |
| `commands/kernel.ts`          | kernel                         |
| `commands/subscription.ts`    | subscription (add/update/use/remove，裸命令即列表) |
| `commands/overwrite.ts`       | overwrite (on/off)             |
| `commands/directory.ts`       | directory (open)               |
| `commands/service.ts`         | install, uninstall             |
| `commands/reset.ts`           | reset                          |
| `commands/doctor.ts`          | doctor（体检诊断，复用核心探测模块） |
| `commands/completion.ts`      | completion（zsh/bash/fish 补全脚本生成与安装） |
| `commands/update.ts`          | update                         |

---

## 命名规范

### 命令别名优先级（高 → 低）

1. 简写单数: `sub`, `dir`, `ow`
2. 简写复数: `subs`, `dirs`
3. 全称单数: `subscription`, `directory`, `overwrite`
4. 全称复数: `subscriptions`, `directories`

### 展示规则

| 场景             | 规则                | 示例                     |
| ---------------- | ------------------- | ------------------------ |
| 帮助文档命令列表 | 全称单数            | `subscription add <url>` |
| 示例、提示       | `mihomo` + 简写单数 | `mihomo sub add <url>`   |

### 内部命名

函数/变量使用**全称单数**:

| 推荐                    | 不推荐           |
| ----------------------- | ---------------- |
| `findSubscriptionFuzzy` | `findSubsFuzzy`  |
| `cmdSubscription`       | `cmdSub`         |
| `readSubscriptionCache` | `readSubsCache`  |
| `readSettingsList`      | `readSettingsLst` |
| `configInfo`            | `cfgInfo`        |
| `overwriteEnabled`      | `owEnabled`      |
| `settingsCache`         | `_settingsCache` |

常量全大写下划线：`DIRECTORY_TARGETS`, `DIRS`, `PATHS`

### `dir open` 目标（精确匹配）

`root`, `subs`, `logs`, `data`, `runtime`, `kernel`

---

## Import 风格

由 Biome 自动排序。分组顺序：内置模块 → 第三方模块 → 本地模块：

```ts
import fs from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';

import { PATHS } from './paths.js';
```

---

## 工具链

| 工具 | 用途 |
|------|------|
| TypeScript | 类型检查 |
| tsup | 构建打包 (esbuild) |
| tsx | 开发运行 |
| Biome | Lint + 格式化 |
| Husky + lint-staged | Git hooks |

---

## 开发命令

```bash
npm run dev            # 用 tsx 直接运行
npm run build          # 构建到 dist/
npm run typecheck      # 类型检查
npm run check          # Biome lint + format 检查
npm run check:fix      # 自动修复
npm run format         # 格式化代码
npm test               # node:test 单测（*.spec.ts，零新增依赖，经 tsx）
```

测试以高危纯函数为主（覆写合并/配置校验/URL 遮蔽/参数校验等），非全量。文件命名 `*.spec.ts`（勿用 `*.test.ts`）。

**副作用路径的判据是「侵入性」，不是「难不难测」**：能在隔离环境里跑真实系统工具的就测（`process-stop.spec.ts` 用 `MIHOMO_CLI_DIR` 指向 tmpdir，`MAIN_INSTANCE_PATTERN` 内嵌绝对路径，物理上不可能误杀用户真在跑的内核）；需要 sudo（改路由表、留 root 残留）或在系统 disabled 表留永久记录的不测——理由见 `CODE_REVIEW.md`「决策豁免」，别当覆盖率缺口重新捡起来。新增此类测试时，**隔离前提本身要有一条断言**，否则哪天前提被破坏，测试会静默扩大杀伤范围而非失败。

**在 worktree 里 `npm run check` 是空转**：`biome.json` 的 `files.includes` 排除 `**/.claude`，而 worktree 建在 `.claude/worktrees/` 下，于是它「Checked 0 files」直接通过。worktree 中改完要显式跑 `npx biome check src/`（修复加 `--write`），否则格式问题会一路漏到提交。

CI 在 `macos-latest` 上跑 typecheck/check/test/build（`.github/workflows/ci.yml`）——因 `os: ["darwin"]`，ubuntu runner 上 `npm ci` 会平台不匹配失败。

---

## 项目级命令

`.claude/commands/` 下固化了两个反复执行的流程（随仓共享）：

- `/release [版本号]`：发布新版本——检查清单、步骤、发布结果核实
- `/wt-done`：worktree 改动合并进 `main` 并就地收尾清理

---

## 工作规则

### 错误处理

命令层与数据层的预期错误一律 `throw new CliError(msg, { label?, hint?, exitCode? })`，由 `index.ts` 的 `main().catch` 单点渲染（`label:` 前缀 + hint 多行 + exitCode）。**不在命令逻辑里 `console.error + process.exit`**。仅两类 exit 保留：信号/全局处理器、`viewLogWithTail` 的 tail 事件回调（main 已 resolve，无法收口）。catch 后重标签需先 `if (e instanceof CliError) throw e`（防双重包裹）。detached/事件回调中不得抛 CliError。

模块顶层（import 阶段求值）也不得抛 CliError——早于 `main().catch` 注册，会直接打印堆栈。需校验的环境变量在**使用点**校验（如 `MIHOMO_CLI_DAEMON_LABEL` 由 `constants.ts` 静默回退默认值 + `service.ts` 写操作入口 `assertServiceLabelSafe()` 抛错）。

`dispatchSubcommand` 是 async，命令 handler 必须 `await`/返回其 Promise。用 `void` 丢弃会让子命令抛的 CliError 变成未处理的 Promise 拒绝、绕过统一渲染。

给某命令补 `onUnknown` 时，原先靠 `fallback` 兜住的隐式子命令必须显式注册，否则会被判为未知子命令。

### 报告成功前必须独立确认

本仓最贵的一类缺陷：**把「命令返回 0」当成「目标达成」**。这类失效不报错、行为却不对，用户没有任何线索。新增「执行某操作并报告结果」的代码时，先问一句：**报告成功的依据，是不是只有「调用没报错」？** 如果是，就需要一次独立的事后确认。

补防线时 grep 同类断言的**全部调用点**——同族路径（install/start/stop/uninstall、service/tun）几乎必然共享同一缺口（v4.2.3 一次修掉七处同族缺陷，共同模式正是「防线只铺了一条路径」）。测试同理：判据要精确匹配正确形态，不要黑名单枚举变体（`-v1` 后缀按名称排序挤在标准版之前，能通过全部旧判据）。

各事故的实测细节锚在对应代码的函数头注释里，复核结论见 `CODE_REVIEW.md` 的「已验证健壮」——不在本文重复，改代码时以那两处为准。

### 平台与 root 守卫

`main()` 开头（`ensureDirs()` 之前）校验 `process.platform === 'darwin'` 与非 root，豁免 `help`/`version`（`index.ts` 的 `GUARD_EXEMPT_COMMANDS` 一份名单两守卫共用）；`MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 为开发逃生阀。守卫必须先于 `ensureDirs`，避免在不支持的平台或 root 的 HOME（可能是 /var/root）创建数据目录。

原因与实测后果（`gui/0` 域恒 125、`openUrl` 吞 ENOENT 恒 true 等）见 `index.ts` 守卫函数的注释。launchd、`open`、sudo、BSD 专有语法均无其他平台实现。

### launchd 服务层

改 `service.ts` 前先读该文件的函数头注释——launchd 的实测事实都锚在对应代码处，且由测试用真实 launchctl 锁住：

- bootstrap 成功 ≠ 进程活着（假健康窗口长度不固定，必须观察满一个窗口）；判据是 `last exit code`
- `enable` 必须在 `bootstrap` 之前；`stop` 恒置 disable 位，「stop 之后 start」是必经路径
- disable 位持久化在 plist 之外，launchctl 没有「清除记录」的动词；uninstall 不清位是刻意的
- 退出码分级：只有 `113` 是「未装载」，`112`/`125` 是查询失败（`assertLaunchctlQueryOk` 收口，`service-exitcode.spec.ts` 锁住）
- **信号死亡走另一个字段**：被 `kill -9`/OOM killer 干掉时 launchd 只写 `last terminating signal = Killed: 9`，`last exit code` **整行消失**（两字段互斥，不跨 bootstrap 残留）。崩溃判据必须两者取一，只看退出码会让这类死法完全不可见。**判据只有一份：`describeExitCause(exitCode, signal)`**，三个消费者共用（`isCrashed` 判有无、`describeAbnormalExit` 供 status/doctor、`assertServiceHealthy` 供 start/install 的失败文案）——**别在任何地方散写 `lastExitCode !== 0`，也别自己拼 `退出码 ${exitCode}`**（信号死亡时它是 null，会显示成「退出码 null」；v4.7.3 收口时正是漏了 `assertServiceHealthy` 这个消费者，v4.7.4 才补上）
- 运行中无法 rename 轮转日志（fd 指向旧 inode），只有「旧进程已退出、新进程未起」的窗口或 copy-truncate 两条路
- `launchctl print` 输出顶层字段单 tab、嵌套双 tab，解析必须锚定 `^\t`（`service.spec.ts` 倒序 fixture 锁死）
- 进程命令行记录的是启动时的路径（符号链名），`MAIN_INSTANCE_PATTERN` 必须二选一分支

另有两条只记一次的事实（手工收尾流程与被排除的设计方案）在 `CODE_REVIEW.md`。

### pgrep/pkill 的 pattern 必须是 POSIX ERE，不是 JS 正则

`MAIN_INSTANCE_PATTERN` 交给 `pgrep -f` / `pkill -f`，它们用 `regcomp(REG_EXTENDED)` 编译——**ERE 没有非捕获组**，`(?:a|b)` 编译失败并以**退出码 2** 结束，失效方式是全线静默（`getMihomoPids()` 恒返回 `[]` → `stop` 判定「不在运行」直接 return 0，内核一直在跑而 CLI 全部认为它不存在）。

两条防线，别只留一条：

- pattern 用 `(a|b)` 而非 `(?:a|b)`。`escapeRegExp` 转义的是**内容**里的元字符，管不了你手写的分组语法
- `getMihomoPids` 对 `pgrep` 退出码只接受 `0`（有匹配）/ `1`（无匹配），其余一律抛 `CliError`。探测失败与「没有进程」必须区分开

回归测试在 `process-probe.spec.ts`，**直接调真实 `pgrep` 编译该 pattern**，不做字符串断言——`\d`、`(?=)`、`{,n}` 等任何 JS-only 语法都会以同样方式失效，让 libc 的 regcomp 当裁判才真的把得住关。

### 平台命令细节

`ps -o command=` 必须带 `-ww`：BSD/macOS 即使 stdout 非 tty 也把该列截断到 79 列，needle 偏移靠后的匹配会恒失败。同理写 BSD/GNU 都要跑的脚本时留意 `stat -f%z`（GNU 为 `-c%s`）。

### 数据写盘前置校验

- **订阅内容**：`saveSubscriptionRawConfig` 是原子覆盖、无备份。写盘前必须经 `assertLooksLikeSubscription`（要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空），否则机场返回的配额/错误 JSON 会不可恢复地覆盖可用订阅
- **订阅列表**：一律经 `getSubscriptions()` 读取，不直接访问 `settings.subscriptions`——非数组值会被展开运算符按字符展开成垃圾列表
- **URL 逗号**：逗号在 query/path 中合法，一律**不切分**。`maskUrl` 按整条 URL 遮蔽——按逗号切分会把 `?nodes=us,hk&token=xxx` 劈开，两段都识别不出 token 参数 → 密钥明文输出
- **`writeFileSync` 的 `mode`** 仅在创建新文件时生效；对可能已存在的文件（sudo 中间脚本）需显式 `chmodSync`

### settings.json / cache.json 的读-改-写必须持锁

多个 CLI 进程会并发跑（慢速 `sub add` 跨整个网络下载期间，用户在另一个终端操作是日常）。`readSettings` 又有进程级缓存，拿陈旧缓存全量写回会把对方刚落盘的改动整块抹掉——**且写入方收到的是成功回执**。

- **数组类改动（`subscriptions`）一律走 `updateSettings(mutate)`**：它持 `withFileLock` 完成「丢缓存 → 读盘上最新 → mutator 算改动 → 写回」。只在 `writeSettings` 里重读盘**不够**，读与写之间仍有窗口
- `writeSettings` 只安全用于单键/整值替换
- mutator 必须同步，且不得再调 `updateSettings`/`writeSettings`——**锁不可重入**，会死等到强夺陈旧锁
- 锁超过 10s 视为持锁进程已崩溃并强夺：宁可退回竞态，也不能让一次崩溃永久锁死 CLI
- **释放前必须校验锁还是自己的**：锁文件写入 `pid+hrtime` token，内容一致才删（被强夺者的 finally 无条件 rm，删掉的是新持有者的锁）
- **锁文件不能放在会被整体 `rmrf` 的目录里**（`runtime/`、`logs/`、`data/`、`subscriptions/`、`kernel/`）：`stop()` 的 `clearRuntime()` 与各 `reset` target 会连目录带锁一起删，持锁方毫不知情，下一个进程立刻拿到锁 → 两个进程同时进临界区。token 所有权校验对此无效（它防误删，不防「锁被连目录删」）
- **`withFileLock(lockPath, fn)` 的参数是锁文件本身，不是被保护的数据文件**：旧签名收数据文件、内部拼 `${filePath}.lock`，锁的位置就被数据文件的位置绑死——`cache.json` 住在 `subscriptions/` 里，锁于是也在那儿，`reset subs` 一删就没了（v4.7.4 只把 `service.lock` 移出 `runtime/`，这条同族路径漏了一版）。现在三把锁（`settingsLock`/`subscriptionCacheLock`/`serviceLock`）都是 `PATHS` 里的显式常量，一律在 `USER_DATA_DIR` 根下
- **新增锁按 `xxxLock` 命名**：`paths.spec.ts` 按该后缀枚举 `PATHS` 做位置断言，照此命名就自动进回归测试（另有一条断言守着「枚举到的锁数量 ≥ 3」，防命名约定被破坏后断言空转成永真）

**`cache.json` 同理**：`saveSubscriptionCache` / `deleteSubscriptionCache` 一律持 `withFileLock`。并发回归测试必须用 `spawn` 并行起子进程，`spawnSync` 逐个跑完根本测不出并发。实测细节见 `settings.ts`/`paths.ts` 注释与 `settings.spec.ts`。

**服务操作同理**：`startService`/`stopService`/`installService`/`uninstallService` 的 enable/bootstrap/bootout/disable 共持 `service.lock`（`service.ts`）——慢速 `start`（订阅更新约 10s）期间另一终端 `stop` 跑完后，start 随后的 `enable` 会把自启位重新打开，终态与用户最后一条命令相反。start 在锁内要再查一次 disabled 再决定是否启动。

### 等进程退出的轮询必须让出事件循环

同步忙等（`Atomics.wait`）会阻塞整个事件循环，**期间 SIGINT 完全不被处理**。故 `cleanupAll` / `stop` / `waitUntilUnloaded` 都是 async，用 `sleep`。

反例是 `withFileLock` 里的 `sleepSyncMs`（该文件内的私有函数，全仓唯一的同步睡眠）：那里**必须同步**——持锁期间让出事件循环，慢速网络下另一进程会等到强夺陈旧锁，等于没锁。两处别混。

`ResetTarget.onBefore` 因此放宽为 `() => void | Promise<void>`，`reset` 循环里要 `await`。

### 内核下载的来源信任

上游 release 不提供 checksums，故**把来源钉死是主要防线**，不是可选加固：

- `assertTrustedAssetUrl` 必须在**加镜像前缀之前**调用——加了前缀整串就以镜像域名开头，无从判断原始 host
- GitHub API **绝不经过镜像**，镜像只作用于产物下载。API 若走镜像，`browser_download_url` 就完全由镜像说了算。代理开着时 API 经本机混合端口转发——本地代理只是传输层，TLS 端到端，响应仍来自 GitHub（fetch 不支持 HTTP 代理，代理路径走 curl）
- 下载通道优先级：显式 `--mirror`/`--mirror direct` 手动覆盖最高；默认 **gh > 本机代理 > 直连**（`resolveDownloadChannel` 纯函数，运行状态由命令层注入）。镜像选择**不持久化**——每次按当前环境独立决策（gh/代理是否可用、网络是否有 IPv6），记住偏好会在换环境后用到错误镜像。gh 通道（`gh release download`）只与 GitHub 通信，信任锚是 gh 本身 + 精确资产名；`--pattern` 是 glob，资产名含 `*?[]` 或路径成分一律拒绝。裸 `--mirror` 的默认镜像按本机 IPv6 情况选（`getDefaultMirror`：有全局 v6 地址走 v6 子域，否则裸域），短别名 `cdn/v4/v6/axisnow` 经 `MIRROR_ALIASES` 展开；`--no-mirror`/`--direct` 已移除，强制直连走 `--mirror direct`
- curl 必须带 `--proto '=https' --proto-redir '=https'`：`-L` 默认跟随任意协议重定向，会降级到明文 http 并落盘。产物随后 `chmod 755` 并在 TUN/daemon 下**以 root 运行**。参数构造在 `buildKernelCurlArgs` 纯函数里，单测锁死
- tar 守卫要同时查**路径**（`-tzf`，条目名干净）与**类型**（`-tvzf` 首字符，拒 `l`/`h`）：symlink 成员的条目名完全合法，能过路径检查却让 `chmod 755` 沿链接作用到任意文件。遍历用 `lstatSync` 不用 `statSync`
- **资产选择必须精确匹配标准版形态**（`mihomo-<platform>-<arch>-vX.Y.Z` 收尾），不能黑名单枚举变体（`-compatible`/`-go`/`-v1`/`-v2`/`-v3` 等后缀全都以版本号结尾）

### quickstart.sh 是内核下载的平行实现

仓根 `quickstart.sh`（curl|sh 一键入口，不经 npm/CLI，给不想装 Node 的用户）用 shell 重新实现了一套：镜像选择、GitHub API 取资产、标准版形态精确匹配、来源 host 白名单、curl 全链路强制 https、`--max-filesize` 上限、下载后比对 `asset.size`、tar 双守卫、订阅内容校验。它与 `kernel.ts` 的信任规则**必须保持一致**——改任一侧的下载/校验逻辑，都要同步检查另一侧（历史上三次对齐——安全水位、资产选择形态、`asset.size` 比对与 `--max-filesize`——都是漂移被人肉发现后补的，没有机制兜底）。

已知分歧（刻意，别当 bug 修）：脚本默认镜像硬编码 v6 子域（无 `getDefaultMirror` 的 IPv6 探测）、支持 linux、不经 launchd 直接前台跑、`--no-mirror`/`--direct` 作为脚本参数保留。`asset.size` 比对在脚本里**需要 jq**（无 jq 时 size 取不到即留空跳过比对，不阻断下载）——CLI 侧无此依赖，属能力差异而非水位差异。

**「无标准版资产时回退第一个匹配项」两侧行为一致**，不是分歧（`kernel.ts` 的 `standardAsset || matchingAssets[0]` 与脚本的 `head -1` 回退，各有单测/注释锁定）。此处曾误记为「CLI 不回退」——而这段文字的用途正是两侧对齐的对照表，写反会误导下次对齐，故特此标注。真正不回退的是 `pickLatestRelease`（全预发布时抛错，别与资产选择混为一谈）。

### 配置的系统锁定项

`external-controller` / `mixed-port` / `secret` / `external-ui*` 是订阅说了不算的字段（`config.ts` 里 `delete` 后由 `systemConfig` 写入），**TUN 模式下 `dns.enable` 同属此列**：TUN 的 `auto-route` + `strict-route` 把 53 端口流量导进 utun、`dns-hijack` 拦下来，内置 DNS 关着就无组件接管，网络直接不可用。

强制 `true` 并加 warning，不拒绝启动——`dns.enable: false` 在 mixed 下完全合法、常由机场下发且用户改不了，硬拒绝等于逼用户先学会写覆写文件才能用 TUN。**只锁 `enable` 一个键**，`nameserver`/`enhanced-mode` 等仍是用户的正当自定义。锁定项覆盖用户显式配置时一律进 `lockedWarnings`（与 `validateConfig` 的 warnings 合并返回），静默改写用户配置不可接受。

dns 形态校验（必须是映射）经 `assertDnsShape` 收口，TUN 与 mixed 两条路径共用——只给一条路径加守卫，另一条照样抛裸 TypeError。

### 覆写语义

`~key` / `+key` / `key+` 是数组语义，目标**已存在且非数组**时抛 `CliError` 而非静默包成单元素数组（会丢字段并生成 mihomo 无法解析的配置）；目标不存在时放行（新增数组的正常用法）。

`exclude-filter` 在 mihomo 侧是无锚点正则搜索，注入节点的排除模式必须 `^(?:...)$` 整名锚定，否则会连带排除名字包含它的订阅节点。

`match` 的订阅名匹配大小写不敏感，与 `findSubscriptionFuzzy` 口径一致。`match` 块**加载侧同样 fail-closed**：块存在但键名打错/值滤空/为空对象时抛 `CliError`，不能 warn 后静默全局生效——运行侧 `matchesScope` 缺 scope 字段时不应用，加载侧降级成「无 match」会让文件作用域反而扩大到所有订阅。`~proxies` 就地 patch 已有节点时**不**注入 exclude-filter（节点本就在池子里，再排除等于把它踢出所有 include-all 分组）；只收「订阅里没有的名字」，判定依据是 buildConfig 传入的订阅原节点集合。

### 命令行选项

选项登记在 `src/flags.ts` 的单一 `FLAGS` 表，`VALUE_FLAGS`（`getNonFlagArg` 跳过带值选项的值）与 start 的重启透传集合（`extractStartOptions`）都从它派生——新增选项只加一条，不再需要同步两张表（旧设计漏登记即静默失效：`sub use foo -s` 丢选项、`logs -n 200` 的 200 被当位置参数）。

- 只登记**带值**选项与 **start 的选项**：布尔选项（`-f`/`-y` 等）以 `-` 开头，`getNonFlagArg` 本就跳过
- `--mirror` 是可选值选项、只走 `parseMirrorArg`，故意不登记
- 已移除的选项（`--no-ssh`、`--mirror-all`）显式报错并给迁移指引，不静默按默认行为继续

### 交互确认与退出码

破坏性操作（`reset`、`sub remove` 模糊匹配）在非 TTY 下**必须抛 `CliError` 退出 1**，不能打印"已取消"后 `return`——退出 0 会让脚本把"什么都没做"误判成执行成功。`confirmPrompt`（`commands/shared.ts`）自带 `!process.stdin.isTTY` 守卫返回 false，调用方需自行区分这两种语义。

### reset 目标顺序：写 settings 的 onAfter 必须排在 settings 之前

`RESET_TARGETS` 的数组顺序即执行顺序。带 `onAfter` 写 `writeSettings` 的目标若排在 `settings` 之后，会把刚删掉的 settings.json **重建出来**，「已重置: 设置」变成谎报。

受此约束的目标登记在 `WRITES_SETTINGS_ON_AFTER`（`subs` 与 `overwrites`），`reset.spec.ts` 按清单遍历断言，**不点名单个目标**——此前只断言了 `subs`，同族的 `overwrites` 带着一模一样的缺陷躺在测试盲区里。

`overwrites` 排错位的后果比「文件被重建」更实际：重建内容是 `{"overwrite_enabled": false}`，而全新数据目录的默认是**启用**。于是 `reset --full` 后用户重新放一份 `overwrite.yaml`，覆写静默不生效且看不出与上次 reset 有关。故除清单断言外，另有两条**端到端**断言（真跑 `reset --full` 后查磁盘状态与 `isOverwriteEnabled()`），它们不依赖清单的正确性——清单漏登记时顺序断言会空过，端到端断言仍失败。

### 归档日志的文件名判据只有一份

`log-files.ts` 的 `ARCHIVE_LOG_RE` / `isArchiveLogFilename` 是清理与列表共用的唯一判据。此前 `cleanupOldLogs` 与 `listLogs` 各写一份正则，只有前者认序号后缀 `mihomo.<ts>.N.log`：那些归档会被按时清理（不堆积）却**永远不出现在 `logs` 列表里**，`logs <编号>` 拿不到它。而序号后缀恰恰产生于「同一秒内二次轮转」——也就是 start 失败后立即重试这个最需要翻日志的场景。

归档路径的分配同样收成一份：`allocateArchivePath()`，`rotateLog`（rename）与 `restartService`（运行中只能 copy-truncate）共用，避免命名规则漂移导致归档被静默覆盖或列不出来。

---

## 关键流程

### 启动流程 (cmdStart)

1. 检查内核 → 获取默认订阅 → 更新过期订阅 → 停止进程 → 生成配置 → 启动

### 配置生成

订阅 YAML → 应用 overwrites → 合并 BASE_CONFIG → TUN 模式合并 TUN_CONFIG → 写入运行时配置

### 覆写配置语法

| 语法     | 作用                  |
| -------- | --------------------- |
| `key!`   | 强制覆盖整个对象      |
| `+key`   | 数组前置插入          |
| `key+`   | 数组追加              |
| `~key`   | 按 `name` 就地合并数组中的单个元素 |
| `<+key>` | 键名以 `+`/`~` 开头时转义 |

覆写文件可在顶部加 `match:` 块限定作用域（`subscription` 按订阅名、`url-domain` 按 URL hostname 后缀；AND 语义；无 `match` 则全局）。`match` 在 `loadOverwriteFile` 阶段剥离，不进入最终配置。

---

## 数据目录

`~/.mihomo-cli/` (可通过 `MIHOMO_CLI_DIR` 自定义)

```
settings.json           # 用户设置
settings.lock           # 跨进程锁（三把锁都在根下，见「settings.json / cache.json 的读-改-写必须持锁」）
subscription-cache.lock
service.lock
overwrite.yaml          # 覆写配置（主文件，可选）
overwrite.*.yaml        # 覆写配置（扩展文件，如 overwrite.dns.yaml）
subscriptions/          # 订阅配置和缓存
kernel/                 # 内核二进制
logs/                   # 当前日志 + 归档日志（mihomo.<时间戳>[.<序号>].log）
data/                   # mihomo 运行数据
runtime/                # pid, config.yaml, 分阶段调试文件(1.subscription/2.overwrite/3.system)
```

`kernel/` 下除内核二进制 `mihomo` 外还有 `install` 建的符号链 `mihomo-cli-service`（→ `mihomo`，相对链接）。
plist 的 `ProgramArguments[0]` 指向它，只为让「登录项与扩展」显示有意义的名字。
`reset kernel` 会连它一起删，故 `install`/`start` 都用 `ensureServiceSymlink()` 幂等重建。

### 服务模型的既定决策（勿重复推翻）

Mixed 由用户级 LaunchAgent 托管（`gui/<uid>`，全程免密）。四条约束，前三条是有人提过反向意见后定下来的：

- **只装 user 域，不提供 `--system` 回退**。曾实现过双域（`DomainSpec` 抽象 + sudo 双路径，约 60 行）后移除：system 域的启停一律需 root（每次输密码），而它想防的「局域网节点被本地网络隐私拦死」在本仓不成立——loopback 不算本地网络，`127.0.0.1` 的 SOCKS 出口根本不触发该机制。真遇到局域网节点被拦再说，别为假想场景预留分支
- **但「识别」遗留 root 安装的能力必须留**（`detectLegacySystemInstall`）：v4.0 及更早装的 root LaunchDaemon 带 KeepAlive，不认它就是个会抢端口、用户无从卸载的幽灵。`install` 前自动清理（一次密码），`status` 检出并告警
- **label 值刻意不改名**（`com.mihomo-cli.daemon`，环境变量 `MIHOMO_CLI_DAEMON_LABEL`）：它是 plist 文件名与 launchd 的注册键，改值等于要求所有老用户做一次带幽灵进程风险的迁移（旧 plist 会持续拉起内核，而新 CLI 完全看不见它），而这个字符串对用户不可见。别再提议改值
- **不自动配置系统代理，也不提供 `proxy on/off` 一类开关**（2026-09 owner 决策）。owner 的用法是「日常只有部分程序需要代理，需要者各自配置」，全局代理反而是错误状态。故 Mixed 启动只提示端口（`cmdStart` 尾部那行文案），绝不碰 `networksetup`。别再提议「一键开系统代理」——要做的最多是把提示文案里的端口写对（跟随 `settings.ports`）

`daemon` / `up` / `down` 三个已移除 token 在 registry 里留了墓碑条目（`commands/removed.ts`），执行时报迁移指引而非 did-you-mean 乱猜。

### TUN 与服务共用 config.yaml，故 `tun` 必须关掉服务自启

plist 的 `ProgramArguments` 与 TUN 启动脚本指向**同一个** `runtime/config.yaml`。TUN 一跑，那份配置就是 `tun.enable = true`——而服务是用户级 LaunchAgent，**以普通用户身份运行，无权创建 utun 设备**。

于是「跑 TUN → 不 stop 直接关机 → 开机」这条极常见的路径会让 launchd 拿 TUN 配置反复拉起一个必然失败的内核（KeepAlive 约 10s 一次），用户开机只看到「代理不通、日志刷爆」，完全联想不到是上次用 TUN 留下的。

两层防御，都要留：

- **`cmdStart` 的 tun 分支在启动前 `disableServiceAutoStart()`**（堵源头）。放在启动前而非启动后：中途失败或 Ctrl+C 也不会留下「自启开着 + TUN 配置」的组合
- **`startService` 拒绝 `getConfigInfo()?.tun` 为真的配置**（兜底）。正常路径下 `cmdStart` 会先按 mixed 重建配置、走不到这里，这层防的是用户手工改 config.yaml 或从旧版本升上来时目录里恰好躺着一份 TUN 配置

不要改成「TUN 退出时自动恢复自启」：TUN 是 sudo 起的独立进程，CLI 早已退出，没有可靠的退出钩子；而「关机」这个场景本就没有任何进程能跑收尾逻辑。恢复自启由用户显式 `mihomo start` 完成。

### ssh 隧道已移除（v4.0.0）

功能价值撑不起维护面（防 `-oProxyCommand=` 注入、真实探测端口识别「假活」、`started_by` 的 auto/manual 语义），而它做的事等价于用户自己跑一条 `ssh -D 127.0.0.1:1080 -N host`。别再加回来。等效能力的配置方法见 README「用 ssh -D 做节点」。

升级残留：老用户的 `settings.json` 里会留着 `ssh` 键、数据目录里会留着 `ssh/` 与 `logs/ssh-*.log`。**刻意不自动清理**——settings 的未知键本就被忽略（`Settings` 接口只读已知字段），孤儿目录不影响任何行为，而自动删用户数据的风险远大于收益。

---

## Git 提交

**不需要**添加 `Co-Authored-By` 行。

### worktree 纪律

本仓改动默认在 `.claude/worktrees/` 下的 git worktree 里做（见用户级规则）。**合并进 `main` 之后就地收尾，不用等人催**——完整步骤用 `/wt-done` 执行。日常三条易踩的坑：

- worktree 隔离会话里，带 heredoc / `&&` 组合的复杂 git 命令会被 harness 拒绝（无法验证操作是否留在 worktree 内）：提交信息先写临时文件再 `git commit -F`，多步操作拆成单条命令执行
- worktree 默认从 `origin/main` 切出（baseRef=fresh）：本地 main 有未推送的提交时，新 worktree 是落后的，开工前先 `git merge --ff-only main` 同步
- **进 worktree 后编辑文件前先重新 Read**：进 worktree 之前读的是**主目录**那份，Edit 的 `old_string` 会因两份文件的细微差异（行尾、上一轮未同步的改动）匹配失败，甚至改错文件。`grep`/`ls` 等相对路径命令在 worktree 里天然指向 worktree，唯独「进 worktree 前读过的文件内容」是陈旧的

合并时若 worktree 与 `main` 改了同一处文档，**保留双方的实测结论**——它们通常是各自独立验证出来的，丢掉任何一条都是白跑一次验证。

---

## 发布流程

版本号：主.次.修订（语义化版本）。发布不经 CI，**发布前必须本地 `npm run typecheck && npm test && npm run check` 全绿**。完整清单、步骤与发布结果核实（CDN 滞后的识别）用 `/release` 执行。
