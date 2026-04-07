# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## 项目概述

- **语言**: Node.js (无需编译)
- **入口**: `index.js`
- **别名**: `mihomo` (推荐), `mmc`, `mh`, `mihomo-cli`

---

## 架构

| 模块                  | 职责                              |
| --------------------- | --------------------------------- |
| `index.js`            | 命令解析、调度                    |
| `src/config.js`       | 路径常量、设置读写、配置构建      |
| `src/subscription.js` | 订阅下载、流量解析、自动更新      |
| `src/process.js`      | 进程启动/停止、PID 管理、日志轮转 |
| `src/kernel.js`       | GitHub Releases 检查、下载        |
| `src/overwrite.js`    | 高级配置合并                      |

---

## 命名规范

### 命令别名优先级（高 → 低）

1. 简写单数: `sub`, `dir`, `ow`
2. 简写复数: `dirs`
3. 全称单数: `subscription`, `directory`, `overwrite`
4. 全称复数: `subscriptions`, `directories`

### 展示规则

| 场景             | 规则                | 示例                     |
| ---------------- | ------------------- | ------------------------ |
| 帮助文档命令列表 | 全称单数            | `subscription add <url>` |
| 示例、提示       | `mihomo` + 简写单数 | `mihomo sub add <url>`   |

### 内部命名

函数/变量使用**全称单数**:

- `findSubscriptionFuzzy` (不用 `findSubsFuzzy`)
- `cmdSubscription` (不用 `cmdSub`)
- `DIRECTORY_TARGETS` (不用 `DIR_TARGETS`)

### `dir open` 目标（精确匹配）

`root`, `subs`, `logs`, `data`, `runtime`, `overwrites`, `settings`, `kernel`

---

## 开发命令

```bash
node index.js          # 运行
node index.js help     # 帮助
```

无测试框架、无 lint。

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
| `<+key>` | 键名以 `+` 开头时转义 |

---

## 数据目录

`~/.mihomo-cli/` (可通过 `MIHOMO_CLI_DIR` 自定义)

```
settings.json           # 用户设置
subscriptions/          # 订阅配置和缓存
overwrites/             # 覆写配置（按文件名排序加载）
core/mihomo             # 内核二进制
logs/                   # 当前日志 + 归档日志
data/                   # mihomo 运行数据
.runtime/               # pid, config.yaml
```

---

## Git 提交

**不需要**添加 `Co-Authored-By` 行。

---

## 发布流程

### 版本号: 主.次.修订 (语义化版本)

### 检查清单（发布前必须完成）

- [ ] 所有新增功能已在 `README.md` 中说明
- [ ] 命令列表与实际代码一致
- [ ] `CHANGELOG.md` 已更新

### 步骤

1. 更新 `package.json` 中的 `version`
2. 在 `CHANGELOG.md` 顶部添加新版本记录
3. **检查并更新 `README.md`**（新增功能、命令变更、示例）
4. 提交: `git add package.json CHANGELOG.md README.md && git commit -m "chore: 发布 vX.Y.Z"`
5. 发布: `npm publish --otp=<6位验证码>`
6. 推送: `git push`
