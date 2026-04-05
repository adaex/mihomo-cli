# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目概述

mihomo-cli 是一个基于命令行的 mihomo (Clash.Meta) 客户端，专为 macOS 设计。

- **语言**: Node.js (无需编译)
- **入口**: `index.js`
- **别名**: `mihomo`, `mmc`, `mh`

---

## 架构概览

```
index.js                    # 主入口：命令解析、调度
├── cmdSubscription()       # 订阅管理 (sub)
├── cmdDirectory()          # 目录操作 (dir)
├── cmdOverwrite()          # 覆写配置 (ow)
├── cmdStart()              # 启动代理
├── cmdStop()               # 停止代理
├── cmdUi()                 # 打开 Web UI
├── cmdLog()/cmdLogs()      # 日志查看
├── cmdKernel()             # 内核更新
└── cmdReset()              # 重置配置

src/
├── config.js               # 配置管理、目录路径、设置读写
├── subscription.js         # 订阅下载、配置生成
├── process.js              # 进程管理、启动/停止、日志
├── kernel.js               # 内核下载更新 (GitHub Releases)
└── overwrite.js            # 覆写配置合并 (支持 ! +<key> 语法)
```

### 模块职责

| 模块 | 职责 |
|------|------|
| `config.js` | 所有路径常量、设置读写、YAML 解析、配置构建 |
| `subscription.js` | 订阅下载、流量解析、自动更新 |
| `process.js` | 进程启动/停止、PID 管理、日志轮转 |
| `kernel.js` | GitHub Releases 检查、下载、解压 |
| `overwrite.js` | 高级配置合并（强制覆盖、数组合并） |

---

## 命名规范

### 命令别名优先级（从高到低）

1. **简写单数**（最高优先级）：`sub`, `dir`, `ow`
2. **简写复数**：`dirs`
3. **全称单数**：`subscription`, `directory`, `overwrite`
4. **全称复数**（最低优先级）：`subscriptions`, `directories`

### 展示规则

| 场景 | 使用形式 | 示例 |
|------|---------|------|
| 帮助文档命令列表 | 全称单数 | `subscription add <url>`, `directory [open]`, `overwrite [on\|off]` |
| 示例、提示等其他场景 | 简写单数 | `mihomo sub add <url>`, `mihomo dir open`, `mihomo ow on` |

### 内部函数/变量命名

使用**全称单数**形式：

| 避免使用（简写/复数） | 使用（全称单数） |
|---------------------|-----------------|
| `findSubsFuzzy` | `findSubscriptionFuzzy` |
| `pickSingleSub` | `pickSingleSubscription` |
| `printSubList` | `printSubscriptionList` |
| `cmdSub` | `cmdSubscription` |
| `cmdDirs` | `cmdDirectory` |
| `DIR_TARGETS` | `DIRECTORY_TARGETS` |

### `dir open` 子命令目标

使用精确匹配，不支持模糊匹配：

| 目标名 | 说明 |
|--------|------|
| `root` | 根目录 |
| `subs` | 订阅目录 |
| `logs` | 日志目录 |
| `data` | mihomo 数据目录 |
| `runtime` | 运行时目录 |
| `overwrites` | 覆写目录 |
| `settings` | 设置文件 |
| `kernel` | 内核目录 |

### 程序入口别名

以下别名等效：
- `mihomo-cli`（程序正式名称，用于版本显示）
- `mihomo`（推荐日常使用）
- `mmc`
- `mh`

**规则**：版本号显示使用 `mihomo-cli vX.Y.Z`，所有命令示例使用 `mihomo`。

---

## 开发命令

无需构建，直接运行：

```bash
node index.js          # 或 node .
node index.js help     # 查看帮助
node index.js start    # 启动代理
```

**无测试框架、无 lint 配置**。

---

## 关键流程

### 启动流程 (cmdStart)
1. 检查内核是否安装
2. 获取当前默认订阅
3. 自动检查/更新过期订阅
4. 停止已有进程
5. 调用 `subscription.prepareConfigForStart()` 生成配置
6. 调用 `process.start()` 启动内核

### 配置生成
1. 读取订阅原始 YAML
2. 应用 `overwrites` 目录下的覆写配置
3. 合并 `BASE_CONFIG`
4. TUN 模式下合并 `TUN_CONFIG`
5. 写入运行时配置文件

### 覆写配置语法 (overwrite.js)
覆写文件支持特殊操作符：
- `key!` - 强制覆盖整个对象（不深度合并）
- `+key` - 数组前置插入
- `key+` - 数组追加
- `<+key>` - 键名以 `+` 开头时的转义

---

## 数据目录

用户数据位于 `~/.mihomo-cli/` (可通过 `MIHOMO_CLI_DIR` 环境变量自定义):

```
~/.mihomo-cli/
├── settings.json         # 用户设置（订阅列表等）
├── subscriptions/
│   ├── cache.json        # 订阅动态缓存
│   └── <name>.yaml       # 订阅原始配置
├── overwrites/           # 覆写配置（按文件名排序加载）
├── core/
│   └── mihomo            # mihomo 内核二进制
├── logs/
│   ├── mihomo.log        # 当前日志
│   └── mihomo.<timestamp>.log  # 归档日志
├── data/                 # mihomo 内核运行数据
└── .runtime/             # 运行时临时文件
    ├── pid               # 进程 PID
    └── config.yaml       # 运行时配置
```

---

## Git 提交

本仓库不需要添加 `Co-Authored-By` 行。

---

## 发布流程

### 版本号规则

遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本号.次版本号.修订号`

- **主版本号**：不兼容的 API 改动
- **次版本号**：向下兼容的功能性新增
- **修订号**：向下兼容的问题修正

### 发布步骤

发布前确保工作区干净（`git status` 无未提交更改）。

#### 1. 更新版本号

修改 `package.json` 中的 `version` 字段。

#### 2. 更新 CHANGELOG.md

在文件顶部添加新版本区块，格式：

```markdown
## [X.Y.Z] - YYYY-MM-DD

### 新增功能
- 描述...

### 修复
- 描述...
```

按类别组织：`新增功能`、`优化`、`重构`、`修复`、`文档`。

#### 3. 提交变更

```bash
git add package.json CHANGELOG.md
git commit -m "chore: 发布 vX.Y.Z"
```

#### 4. 发布到 npm

```bash
npm publish --otp=<6位验证码>
```

需要 npm 账户的 OTP 二次验证码。

#### 5. 推送到远程

```bash
git push
```

### 完整示例

```bash
# 1. 编辑 package.json: 1.1.0 -> 1.2.0
# 2. 编辑 CHANGELOG.md，添加新版本记录
git add package.json CHANGELOG.md
git commit -m "chore: 发布 v1.2.0"
npm publish --otp=123456
git push
```
