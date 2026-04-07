# Changelog

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
