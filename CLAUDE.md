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
| `src/process.ts`           | 进程启动/停止、PID 管理、日志轮转、进程探测（isProcess*） |
| `src/daemon.ts`            | launchd 保活：开机自启/崩溃重启、热重载、状态查询 |
| `src/runtime.ts`           | 运行时门面：收敛普通进程/保活双轨（模式、状态、启停） |
| `src/lifecycle.ts`         | 退出清理注册表（信号/异常退出前杀掉测试实例） |
| `src/test-instance.ts`     | 隔离测速实例（独立端口，不动主实例）withTestInstance |
| `src/progress.ts`          | 测速进度打印、结果汇总格式化      |
| `src/kernel.ts`            | GitHub Releases 检查、下载        |
| `src/overwrite.ts`         | 覆写配置合并                      |
| `src/commands/registry.ts` | 命令注册表（name/别名/handler/argv 改写/help 用法），路由与帮助的单一真相源 |
| `src/commands/shared.ts`   | 命令层公共工具：dispatchSubcommand 子命令分发、confirmPrompt、requireRunning、restartToApply |
| `src/commands/*.ts`        | 各命令处理器（每命令一个文件）    |

### 命令处理器

| 文件                          | 命令                           |
| ----------------------------- | ------------------------------ |
| `commands/help.ts`            | help, version, 简短帮助       |
| `commands/status.ts`          | status                         |
| `commands/start.ts`           | start, tun                     |
| `commands/stop.ts`            | stop                           |
| `commands/log.ts`             | log, logs                      |
| `commands/ui.ts`              | ui                             |
| `commands/kernel.ts`          | kernel                         |
| `commands/subscription.ts`    | subscription (list/add/update/use/remove/web/test/clean) |
| `commands/test.ts`            | test, clean（经主实例测速）    |
| `commands/overwrite.ts`       | overwrite (on/off/list)        |
| `commands/directory.ts`       | directory (open/list)          |
| `commands/daemon.ts`          | daemon (on/off/status)         |
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
| `processManager`        | `processMgr`     |
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

测试仅覆盖高危纯函数（覆写合并/配置校验/名称归一/URL 遮蔽/参数校验等），非全量。文件命名 `*.spec.ts`（勿用 `*.test.ts`，会与 test.ts/test-instance.ts 冲突）。

CI 在 `macos-latest` 上跑 typecheck/check/test/build（`.github/workflows/ci.yml`）——因 `os: ["darwin"]`，ubuntu runner 上 `npm ci` 会平台不匹配失败。

### 错误处理

命令层与数据层的预期错误一律 `throw new CliError(msg, { label?, hint?, exitCode? })`，由 `index.ts` 的 `main().catch` 单点渲染（`label:` 前缀 + hint 多行 + exitCode）并 `runCleanup()`。**不在命令逻辑里 `console.error + process.exit`**。仅两类 exit 保留：信号/全局处理器、`viewLogWithTail` 的 tail 事件回调（main 已 resolve，无法收口）。catch 后重标签需先 `if (e instanceof CliError) throw e`（防双重包裹）。detached/事件回调中不得抛 CliError。

模块顶层（import 阶段求值）也不得抛 CliError——早于 `main().catch` 注册，会直接打印堆栈。需校验的环境变量在**使用点**校验（如 `MIHOMO_CLI_DAEMON_LABEL` 由 `constants.ts` 静默回退默认值 + `daemon.ts` 写操作入口 `assertDaemonLabelSafe()` 抛错）。

`dispatchSubcommand` 是 async，命令 handler 必须 `await`/返回其 Promise。用 `void` 丢弃会让子命令抛的 CliError 变成未处理的 Promise 拒绝、绕过统一渲染。

给某命令补 `onUnknown` 时，原先靠 `fallback` 兜住的隐式子命令（如 `ow list`/`dir list`）必须显式注册，否则会被判为未知子命令。

### 平台守卫

`main()` 开头（`ensureDirs()` 之前）校验 `process.platform === 'darwin'`，`package.json` 声明 `"os": ["darwin"]`。豁免 `help`/`version`；`MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 为开发逃生阀。守卫必须先于 `ensureDirs`，避免在不支持的平台创建数据目录。

原因：launchd 保活、`open`、`sudo`、BSD 专有命令语法（`stat -f%z`、`ps -o command=`）均无其他平台实现，且 `openUrl` 吞掉 ENOENT 后恒返回 true，非 macOS 上会「报告成功但什么都没做」。

### 平台命令细节

`ps -o command=` 必须带 `-ww`：BSD/macOS 即使 stdout 非 tty 也把该列截断到 79 列，needle 偏移靠后的匹配（测速实例的 config 路径）会恒失败。同理写 BSD/GNU 都要跑的脚本时留意 `stat -f%z`（GNU 为 `-c%s`）。

### 数据写盘前置校验

- **订阅内容**：`saveSubscriptionRawConfig` 是原子覆盖、无备份。写盘前必须经 `assertLooksLikeSubscription`（要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空），否则机场返回的配额/错误 JSON 会不可恢复地覆盖可用订阅
- **订阅列表**：一律经 `getSubscriptions()` 读取，不直接访问 `settings.subscriptions`——非数组值会被展开运算符按字符展开成垃圾列表
- **URL 逗号**：逗号在 query/path 中合法。多源判据统一为「切分后每段都是合法 http(s) URL 且不止一段」，三处实现需同步（`settings.maskUrl`、`subscription.isMultiUrl`/`splitUrls`、`overwrite.splitUrlsLocal`）。只看「含逗号」会泄漏 token，只看「整体可解析」会漏遮蔽真多源
- **`writeFileSync` 的 `mode`** 仅在创建新文件时生效；对可能已存在的文件（sudo 中间脚本）需显式 `chmodSync`

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
runtime/                # pid, config.yaml, 分阶段调试文件(1.subscription/2.overwrite/3.system.yaml)
```

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

`npm publish` 打印 `+ mihomo-cli@X.Y.Z` **不代表已生效**，而 `npm view` / registry 元数据 JSON 的 CDN 同步可滞后数分钟，期间仍显示旧版本。核实要直接查版本文档与产物：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/mihomo-cli/X.Y.Z
curl -s -o /tmp/t.tgz -w "%{http_code} %{size_download}\n" \
  https://registry.npmjs.org/mihomo-cli/-/mihomo-cli-X.Y.Z.tgz
```

两者 200 且字节数与本地 `npm pack --dry-run` 一致即已落地。重跑 `npm publish` 得到 `403 You cannot publish over the previously published versions` 同样是"已成功"的证据（不是失败）。

### 交互确认与退出码

破坏性操作（`reset`、`sub remove` 模糊匹配）在非 TTY 下**必须抛 `CliError` 退出 1**，不能打印"已取消"后 `return`——退出 0 会让脚本把"什么都没做"误判成执行成功。`confirmPrompt`（`commands/shared.ts`）自带 `!process.stdin.isTTY` 守卫返回 false，调用方需自行区分这两种语义。

