# Changelog

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
