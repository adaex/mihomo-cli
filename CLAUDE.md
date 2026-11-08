# CLAUDE.md

本仓开发入口。这里只保留每次任务都需要的事实、安全边界与文档导航；具体做法按任务打开，不预读链接文档

## 项目

macOS 命令行客户端，TypeScript ESM，Node.js >= 24.20.0。入口 `src/index.ts`，tsx 开发，tsup 打包。命令入口 `mihomo-cli`（全称）/ `mh`（简写），`package.json` 的 bin 是唯一登记表

## 常驻安全边界

- 开发验证不得操作真实的 `~/.mihomo-cli`、LaunchAgent 或系统网络设置，也不得拿真实配置做夹具；不把裸 `npm run dev` 当验证命令，隔离要求见 [开发约定](docs/development.md)
- 真实 sudo/TUN 与永久污染 launchd disabled 表的用例不自动执行；测试边界见 [开发约定](docs/development.md#自动化测试边界)

## 按任务打开

| 文档 | 什么时候打开 |
| --- | --- |
| [开发约定](docs/development.md) | 改代码或测试前阅读全文 |
| [架构与契约](docs/architecture.md) | 查模块职责、产品边界或跨模块契约；改对应域前只读相关节 |
| [README](README.md) | 查改用户承诺、命令行为或使用示例 |
| [覆写配置详版](docs/overwrite.md) | 查改覆写的用户语法与示例；不是内部实现约定 |
| [安全说明](SECURITY.md) | 查改安全边界、漏洞报告方式或支持范围 |
| [重构待办](docs/todo.md) | 正要改对应域，需要核对刻意推迟的结构性重构 |
| [发布流程](docs/release.md) | 用户明确要求发布时 |

## 需要查证时再打开

| 文档 | 什么时候打开 |
| --- | --- |
| [架构决策](docs/decisions.md) | 需要某条决策的背景、理由或拒绝过的替代方案；按 D 编号或标题搜索，无需通读全文 |
| [现行结论与边界](CONCLUSIONS.md) | 涉及相关实测结论、已知风险或验证边界；按模块名或关键词搜索，只读命中条目，改到对应代码时同步更新 |
| [CHANGELOG](CHANGELOG.md) | 查用户可见版本历史或补当轮变化 |

## 文档归属

- 一条事实只有一个归属，其余处链接：契约与模块职责 → architecture；决策与拒绝过的替代 → decisions；实测结论、已知风险与验证边界 → CONCLUSIONS；用户语法与示例 → README / overwrite.md；刻意推迟的重构 → todo
- 代码注释只写判据与契约；修复过程与版本史留在 CHANGELOG / git，不复制进现行文档
- CHANGELOG 只写用户可见变化，每条 1–3 句：不记内部清理，不按审查轮次组织，不写测试计数

## Git 与流程

- 提交前用 `git status` 逐文件核对改动归属，避免混入并行代理未提交的工作；不需要 Co-Authored-By
- 文档冲突保留双方的用户可见变化、实测结论与现行约定
- 发布仅在用户要求时执行，按 [发布流程](docs/release.md)
