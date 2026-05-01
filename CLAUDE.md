# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## 项目概述

- **语言**: TypeScript (ESM)
- **入口**: `src/index.ts`
- **构建**: `tsup` → `dist/index.js` (单文件打包)
- **开发运行**: `tsx src/index.ts`
- **别名**: `mihomo` (推荐), `mhm`, `mh`, `mihomo-cli`
- **运行时**: Node.js >= 22

---

## 架构

| 模块                       | 职责                              |
| -------------------------- | --------------------------------- |
| `src/index.ts`             | 命令路由、信号处理、main()        |
| `src/types.ts`             | 所有类型定义（集中管理）          |
| `src/constants.ts`         | 默认配置、UI URLs、镜像列表      |
| `src/utils.ts`             | 颜色、格式化、flag 解析、HTTP     |
| `src/paths.ts`             | 路径常量、目录管理                |
| `src/settings.ts`          | settings.json 读写、订阅缓存     |
| `src/config.ts`            | 配置构建、YAML 解析、内核版本    |
| `src/subscription.ts`      | 订阅下载、流量解析、自动更新      |
| `src/process.ts`           | 进程启动/停止、PID 管理、日志轮转 |
| `src/kernel.ts`            | GitHub Releases 检查、下载        |
| `src/overwrite.ts`         | 覆写配置合并                      |
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
| `commands/subscription.ts`    | subscription (add/update/use/remove/list/test/clean/web) |
| `commands/overwrite.ts`       | overwrite (on/off/list)        |
| `commands/directory.ts`       | directory (open/list)          |
| `commands/reset.ts`           | reset                          |
| `commands/update.ts`          | update                         |

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

import yaml from 'js-yaml';

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
```

无测试框架。

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
overwrite.yaml          # 覆写配置（主文件，可选）
overwrite.*.yaml        # 覆写配置（扩展文件，如 overwrite.dns.yaml）
subscriptions/          # 订阅配置和缓存
kernel/                 # 内核二进制
logs/                   # 当前日志 + 归档日志
data/                   # mihomo 运行数据
runtime/                # pid, config.yaml
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
4. 构建: `npm run build`
5. 提交: `git add . && git commit -m "chore: 发布 vX.Y.Z"`
6. 发布: `npm publish`
7. 推送: `git push`
