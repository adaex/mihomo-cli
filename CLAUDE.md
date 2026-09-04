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
| `src/utils.ts`             | 纯函数小工具：sleep、escapeRegExp/shellQuote、格式化、flag 解析、did-you-mean |
| `src/colors.ts`            | 颜色与 NO_COLOR                   |
| `src/errors.ts`            | CliError、TimeoutError、withTimeout |
| `src/http.ts`              | HTTP 客户端（超时、响应体大小上限、Bearer） |
| `src/paths.ts`             | 路径常量、目录管理                |
| `src/settings.ts`          | settings.json 读写（含损坏恢复）、订阅缓存、订阅列表增删、URL 遮蔽 |
| `src/config.ts`            | 配置构建、YAML 解析/序列化、内核版本 |
| `src/subscription.ts`      | 订阅下载、流量解析、自动更新      |
| `src/process-probe.ts`     | 进程探测：ps/pgrep、pid 文件、运行状态、getStatus |
| `src/process-start.ts`     | TUN 内核启动（sudo 脚本）。Mixed 无用户态路径，由 service.ts 托管 |
| `src/process-stop.ts`      | 内核停止/清理：stop、cleanupAll、clearPid |
| `src/log-files.ts`         | 日志轮转/清理/列表/路径 |
| `src/open.ts`              | openUrl/openLogFile/viewLogWithTail |
| `src/sudo.ts`              | runSudoScript：TUN 与系统级服务共用的 sudo 脚本范式 |
| `src/service.ts`           | launchd 服务：双域(用户级 LaunchAgent / 系统级 LaunchDaemon)、install/start/stop/uninstall、热重载、状态查询、符号链 |
| `src/runtime.ts`           | 运行时门面：收敛 service(Mixed)/tun 双轨（模式、状态、启停） |
| `src/lifecycle.ts`         | 退出清理注册表（信号/异常退出前清理 detached 子进程） |
| `src/kernel.ts`            | GitHub Releases 检查、下载        |
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
| `commands/service.ts`         | install (--system), uninstall  |
| `commands/reset.ts`           | reset                          |
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

测试仅覆盖高危纯函数（覆写合并/配置校验/URL 遮蔽/参数校验等），非全量。文件命名 `*.spec.ts`（勿用 `*.test.ts`）。

**在 worktree 里 `npm run check` 是空转**：`biome.json` 的 `files.includes` 排除 `**/.claude`，而 worktree 建在 `.claude/worktrees/` 下，于是它「Checked 0 files」直接通过。worktree 中改完要显式跑 `npx biome check src/`（修复加 `--write`），否则格式问题会一路漏到提交。

CI 在 `macos-latest` 上跑 typecheck/check/test/build（`.github/workflows/ci.yml`）——因 `os: ["darwin"]`，ubuntu runner 上 `npm ci` 会平台不匹配失败。

### 错误处理

命令层与数据层的预期错误一律 `throw new CliError(msg, { label?, hint?, exitCode? })`，由 `index.ts` 的 `main().catch` 单点渲染（`label:` 前缀 + hint 多行 + exitCode）并 `runCleanup()`。**不在命令逻辑里 `console.error + process.exit`**。仅两类 exit 保留：信号/全局处理器、`viewLogWithTail` 的 tail 事件回调（main 已 resolve，无法收口）。catch 后重标签需先 `if (e instanceof CliError) throw e`（防双重包裹）。detached/事件回调中不得抛 CliError。

模块顶层（import 阶段求值）也不得抛 CliError——早于 `main().catch` 注册，会直接打印堆栈。需校验的环境变量在**使用点**校验（如 `MIHOMO_CLI_DAEMON_LABEL` 由 `constants.ts` 静默回退默认值 + `service.ts` 写操作入口 `assertServiceLabelSafe()` 抛错）。

`dispatchSubcommand` 是 async，命令 handler 必须 `await`/返回其 Promise。用 `void` 丢弃会让子命令抛的 CliError 变成未处理的 Promise 拒绝、绕过统一渲染。

给某命令补 `onUnknown` 时，原先靠 `fallback` 兜住的隐式子命令必须显式注册，否则会被判为未知子命令。

### 新增命令行选项要同步 utils.ts

`hasFlag`/`parseIntArg`/`parseStringArg` 只管解析，**新选项还要登记到 `utils.ts` 的两张表**，否则在真实用法里静默失效：

- **布尔选项 → `extractStartOptions` 的 `BOOL_FLAGS`**：不登记则 `sub use foo -s` 触发的重启会丢掉该选项（`ow on/off`、`sub use` 都经 `restartToApply` 重新调 `cmdStart`）
- **带值选项 → `VALUE_FLAGS`**：不登记则 `getNonFlagArg` 会把选项的值误当位置参数（`logs -n 200` 里的 `200` 被当成日志编号）

两者都是「不报错但行为不对」的失效方式，写完选项顺手 grep 一下这两张表。

### 平台守卫

`main()` 开头（`ensureDirs()` 之前）校验 `process.platform === 'darwin'`，`package.json` 声明 `"os": ["darwin"]`。豁免 `help`/`version`；`MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 为开发逃生阀。守卫必须先于 `ensureDirs`，避免在不支持的平台创建数据目录。

原因：launchd 服务、`open`、`sudo`、BSD 专有命令语法（`stat -f%z`、`ps -o command=`）均无其他平台实现，且 `openUrl` 吞掉 ENOENT 后恒返回 true，非 macOS 上会「报告成功但什么都没做」。

### launchd 实测事实（v5.0.0 服务化时逐条验证）

改这块前先读这里，几条都是「文档不写、猜错就静默出错」的：

- **`bootstrap` 一个被 disable 的 label 是硬失败**（`Bootstrap failed: 5: Input/output error`），不是「加载了但不启动」。故 `enable` 必须在 `bootstrap` 之前，顺序不可换。而 `stop` 恒置 disable 位，「stop 之后 start」是最常走的路径——少了 enable 就 100% 失败
- **disable 位持久化在 `/var/db/com.apple.xpc.launchd/disabled*.plist`，与 plist 文件相互独立**：删掉 plist 后该位仍在。且 launchctl **没有「清除记录」的动词**，`enable` 同样写一条 `=> enabled`。故 `parseDisabledList` 必须区分 `disabled`/`enabled` 两种值，只判断「在不在表里」会把 enable 过的服务误判成已禁用
- **`launchctl print <target>` 与 `print-disabled <domain>` 均免 sudo**（对 system 域也是），实测 3ms。退出码 `113` = 未装载，`0` = 已装载。这让状态查询能拿到真实 state/pid，取代早期 pgrep + root 属主过滤的近似判断
- **`launchctl print` 输出里顶层字段是单 tab（`\tstate = running`），嵌套 endpoint 是双 tab（`\t\tstate = active`）**。解析必须锚定 `^\t`。实测多个真实服务顶层 state 都排在嵌套之前，不锚定「碰巧」也对——但那是 launchd 的实现细节不是契约，`service.spec.ts` 用倒序 fixture 锁死了锚定行为
- **`KeepAlive.PathState` 不能用来实现 stop**：删掉 flag 文件后进程照跑不误，`KeepAlive` 只决定「退出后是否重启」，不主动终止运行中的任务。这条排除了「flag 文件 + root daemon 免密」的方案
- **本地网络隐私的豁免条件是「以 root 运行」，不是「身为 daemon」**（Apple DTS 原话）。用户级 LaunchAgent 不豁免，但走的是正常弹框授权流程，不是被静默拦死——被拦死的是无人登录、没人能点弹框的服务器场景。这是 v5.0.0 敢把默认域从 system 改成 user 的依据
- **进程命令行记录的是启动时用的路径**：服务经符号链 `kernel/mihomo-cli-service` 启动，`ps -ww -o command=` 输出的就是符号链名，用真实二进制名 `pgrep -f` 匹配不到。`MAIN_INSTANCE_PATTERN` 因此是二选一分支，两条都要留

### 平台命令细节

`ps -o command=` 必须带 `-ww`：BSD/macOS 即使 stdout 非 tty 也把该列截断到 79 列，needle 偏移靠后的匹配会恒失败（当前唯一 needle 是偏移 0 的 binary 路径，新增调用方时别把 `-ww` 去掉）。同理写 BSD/GNU 都要跑的脚本时留意 `stat -f%z`（GNU 为 `-c%s`）。

### 数据写盘前置校验

- **订阅内容**：`saveSubscriptionRawConfig` 是原子覆盖、无备份。写盘前必须经 `assertLooksLikeSubscription`（要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空），否则机场返回的配额/错误 JSON 会不可恢复地覆盖可用订阅
- **订阅列表**：一律经 `getSubscriptions()` 读取，不直接访问 `settings.subscriptions`——非数组值会被展开运算符按字符展开成垃圾列表
- **URL 逗号**：逗号在 query/path 中合法，一律**不切分**（v3.10.0 起，随多源合并订阅一并移除）。`maskUrl` 按整条 URL 遮蔽——按逗号切分会把 `?nodes=us,hk&token=xxx` 劈开，两段都识别不出 token 参数 → 密钥明文输出
- **`writeFileSync` 的 `mode`** 仅在创建新文件时生效；对可能已存在的文件（sudo 中间脚本）需显式 `chmodSync`

### settings.json 的读-改-写必须持锁

`settings.json` 装订阅列表，而多个 CLI 进程会并发跑（慢速 `sub add` 跨整个网络下载期间，用户在另一个终端操作是日常）。`readSettings` 又有进程级缓存，拿陈旧缓存全量写回会把对方刚落盘的改动整块抹掉——**且写入方收到的是成功回执**（实测 6 并发 `sub add` 丢 3 条）。

- **数组类改动（`subscriptions`）一律走 `updateSettings(mutate)`**：它持 `withFileLock` 完成「丢缓存 → 读盘上最新 → mutator 算改动 → 写回」。只在 `writeSettings` 里重读盘**不够**，读与写之间仍有窗口（实测 6 并发仍丢 3 条）
- `writeSettings` 只安全用于单键/整值替换
- mutator 必须同步，且不得再调 `updateSettings`/`writeSettings`——**锁不可重入**，会死等到强夺陈旧锁
- 锁超过 10s 视为持锁进程已崩溃并强夺：宁可退回竞态，也不能让一次崩溃永久锁死 CLI

**`cache.json` 同理，别只想着 settings**（v3.12.1 修）：`saveSubscriptionCache` 曾以「全程同步、读写之间无 await」自证安全，但那只在单进程内成立。跨进程下它就是裸读-改-写——实测 4 进程各写 30 条丢 7 条。丢的是 `updated_at` → `needsAutoUpdate` 恒 true → 该订阅每次 `start` 都重新下载，且流量/到期展示一并消失。写入路径（`saveSubscriptionCache` / `deleteSubscriptionCache`）一律持 `withFileLock`，回归测试在 `settings.spec.ts`（必须用 `spawn` 并行起子进程，`spawnSync` 逐个跑完根本测不出并发）。

### 等进程退出的轮询用 async sleep，不用 sleepSync

`sleepSync`（`Atomics.wait`）阻塞整个事件循环，**期间 SIGINT 完全不被处理**：`cleanupAll` 的 50×100ms 忙等实测要走完全程、5.3 秒后才响应 Ctrl+C，用户会以为 CLI 挂死。故 `cleanupAll` / `stop` / `stopSshTunnel` 及其包装（`stopAutoSshTunnels`/`stopAllSshTunnels`）都是 async，用 `sleep`。改后实测 102ms 响应。

反例是 `withFileLock` 里的 `sleepSyncMs`：那里**必须同步**——持锁期间让出事件循环，慢速网络下另一进程会等到强夺陈旧锁，等于没锁。两处别混。

`ResetTarget.onBefore` 因此放宽为 `() => void | Promise<void>`，`reset` 循环里要 `await`。

### 内核下载的来源信任

上游 release 不提供 checksums（127 个资产实测，注释属实），故**把来源钉死是主要防线**，不是可选加固：

- `assertTrustedAssetUrl` 必须在**加镜像前缀之前**调用——加了前缀整串就以镜像域名开头，无从判断原始 host
- GitHub API **恒直连**（v3.10.0 移除 `--mirror-all`），镜像只作用于产物下载。API 若走镜像，`browser_download_url` 就完全由镜像说了算，而 `withMirror` 对非 github URL 原样放行 —— `assertTrustedAssetUrl` 因此是纵深防御的第二道，不可省
- curl 必须带 `--proto '=https' --proto-redir '=https'`：`-L` 默认跟随任意协议重定向，实测会降级到明文 http 并落盘。产物随后 `chmod 755` 并在 TUN/daemon 下**以 root 运行**
- tar 守卫要同时查**路径**（`-tzf`，条目名干净）与**类型**（`-tvzf` 首字符，拒 `l`/`h`）：symlink 成员的条目名完全合法，能过路径检查却让 `chmod 755` 沿链接作用到任意文件。遍历用 `lstatSync` 不用 `statSync`

### 覆写语义

`~key` / `+key` / `key+` 是数组语义，目标**已存在且非数组**时抛 `CliError` 而非静默包成单元素数组（会丢字段并生成 mihomo 无法解析的配置）；目标不存在时放行（新增数组的正常用法）。

`exclude-filter` 在 mihomo 侧是无锚点正则搜索，注入节点的排除模式必须 `^(?:...)$` 整名锚定，否则会连带排除名字包含它的订阅节点。

`match` 的订阅名匹配大小写不敏感，与 `findSubscriptionFuzzy` 口径一致。

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
overwrite.yaml          # 覆写配置（主文件，可选）
overwrite.*.yaml        # 覆写配置（扩展文件，如 overwrite.dns.yaml）
subscriptions/          # 订阅配置和缓存
kernel/                 # 内核二进制
logs/                   # 当前日志 + 归档日志
data/                   # mihomo 运行数据
runtime/                # pid, config.yaml, 分阶段调试文件(1.subscription/2.overwrite/3.system)
```

`kernel/` 下除内核二进制 `mihomo` 外还有 `install` 建的符号链 `mihomo-cli-service`（→ `mihomo`，相对链接）。
plist 的 `ProgramArguments[0]` 指向它，只为让「登录项与扩展」显示有意义的名字。
`reset kernel` 会连它一起删，故 `install`/`start` 都用 `ensureServiceSymlink()` 幂等重建。

### daemon → 服务模型（v5.0.0）

`daemon` 命令、`src/daemon.ts` / `commands/daemon.ts`、`up`/`down` 别名全部删除，
换成 `install`/`start`/`stop`/`uninstall`。三个已移除 token 在 registry 里留了墓碑条目
（`commands/removed.ts`），执行时报明确的迁移指引——同 `--no-ssh` 的先例。

**默认域从 system 改为 user 是这次的核心决策**，理由与推翻的旧结论：

- 旧结论（v3.0.0，README 曾逐字保留）：「必须用 root LaunchDaemon，用户级 LaunchAgent 会被
  macOS 本地网络隐私静默拦成 no route to host」
- 推翻依据：Apple DTS 明确「豁免条件是**以 root 运行**」，不是「身为 daemon」。LaunchAgent
  确实不豁免，但那意味着**走正常弹框授权**（点一次「允许」永久生效），不是被拦死。
  旧结论描述的是无人登录、没人能点弹框的场景
- 代价对比：system 域的 `bootstrap`/`bootout`/`enable`/`disable` 一律需 root → 每次启停输密码；
  user 域全程免密，代价是局域网节点首次需点一次授权，且换内核后可能需重新授权
- `--system` 保留为回退路径，两域命令语义完全一致，`DomainSpec` 收敛差异

**label 值刻意不改名**（仍是 `com.mihomo-cli.daemon`，环境变量仍是 `MIHOMO_CLI_DAEMON_LABEL`）：
它是 plist 文件名与 launchd 的注册键，改值等于要求所有老用户做一次带幽灵进程风险的迁移
（旧 plist 带 KeepAlive 会持续拉起内核，而新 CLI 完全看不见它），而这个字符串对用户不可见。
只改了代码里的标识符名。别再提议改值。

### ssh 隧道已移除（v4.0.0）

`ssh` 命令、`src/ssh.ts` / `commands/ssh.ts`、`DIRS.ssh`、settings 的 `ssh` 字段、
`start`/`stop` 的 `--no-ssh`、`reset` 的 ssh 目标、`docs/ssh-requirement.md` 全部删除。

演进轨迹（别再走一遍）：v3.9.0 `tunnel` 统一为 `ssh` → v3.12.0 剥离配置层、弱化为
「只管端口」→ v4.0.0 整体移除。功能价值始终撑不起它的维护面：既要防 `--host` 的
`-oProxyCommand=` 注入、又要真实探测端口识别「假活」、还要维护 `started_by` 的
auto/manual 单向提升语义以免 `stop` 误杀，而它做的事等价于用户自己跑一条
`ssh -D 127.0.0.1:1080 -N host`。

要恢复等效能力：自己起 `ssh -D`，节点与分流规则写进 `overwrite.yaml`：

```yaml
~proxies:
  - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
+rules:
  - DOMAIN-SUFFIX,example.internal,SSH-work
```

升级残留：老用户的 `settings.json` 里会留着 `ssh` 键、数据目录里会留着 `ssh/`
与 `logs/ssh-*.log`。**刻意不自动清理**——settings 的未知键本就被忽略（`Settings`
接口只读已知字段），孤儿目录不影响任何行为，而自动删用户数据的风险远大于收益。

---

## Git 提交

**不需要**添加 `Co-Authored-By` 行。

---

## 发布流程

### 版本号: 主.次.修订 (语义化版本)

### 检查清单（发布前必须完成）

- [ ] `npm run typecheck && npm test && npm run check` 全绿（CI 也会跑，但发布不经 CI）
- [ ] 所有新增功能已在 `README.md` 中说明
- [ ] 命令列表与实际代码一致
- [ ] `CHANGELOG.md` 已更新
- [ ] 若本轮改了 `CODE_REVIEW.md` 涉及的代码，同步更新该文档的状态

### 步骤

1. 更新 `package.json` 中的 `version`
2. 在 `CHANGELOG.md` 顶部添加新版本记录
3. **检查并更新 `README.md`**（新增功能、命令变更、示例）
4. 构建: `npm run build`（`prepublishOnly` 已兜底，此步为提前验证）
5. 提交: `git add . && git commit -m "chore: 发布 vX.Y.Z"`
6. 发布: `npm publish`
7. 推送: `git push`

### 发布结果核实

**`npm publish` 不报错即视为发布成功，就此收工，不等 CDN 落地。**

registry 的 CDN 同步可滞后数分钟：期间版本文档与产物 URL 都是 404、`npm view` 的 `latest` 仍是旧版本、重跑 `npm publish` 会得到 `409 Cannot publish over previously staged version`（staged ≠ published，说明还在处理队列）。这些都**不是**失败信号，只是还没同步完，不必守着等它变 200。

若确实需要确认某个版本已对外可见（比如要通知别人升级），再查：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/mihomo-cli/X.Y.Z
```

200 即已落地。重跑 `npm publish` 得到 `403 You cannot publish over the previously published versions` 同样是已落地的证据。

### 交互确认与退出码

破坏性操作（`reset`、`sub remove` 模糊匹配）在非 TTY 下**必须抛 `CliError` 退出 1**，不能打印"已取消"后 `return`——退出 0 会让脚本把"什么都没做"误判成执行成功。`confirmPrompt`（`commands/shared.ts`）自带 `!process.stdin.isTTY` 守卫返回 false，调用方需自行区分这两种语义。

