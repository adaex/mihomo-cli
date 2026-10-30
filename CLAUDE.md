# CLAUDE.md

本仓开发入口。这里只保留每次任务都需要的事实、安全边界与文档导航；具体做法按任务打开，不预读链接文档

## 项目

macOS 命令行客户端，TypeScript ESM，Node.js >= 24.20.0。入口 `src/index.ts`，tsx 开发，tsup 打包。命令入口 `mihomo-cli`（全称）/ `mh`（简写），`package.json` 的 bin 是唯一登记表

## 常驻安全边界

- 开发验证不得操作真实的 `~/.mihomo-cli`、LaunchAgent 或系统网络设置；不把裸 `npm run dev` 当验证命令，隔离要求见 [开发约定](docs/development.md)
- 真实 sudo/TUN 与永久污染 launchd disabled 表的用例不自动执行；测试边界见 [CONCLUSIONS](CONCLUSIONS.md#自动化测试边界)
- 只有查改当前用户真实的 `~/.mihomo-cli` 时才读 [本机真实配置](docs/local-config.md)；普通开发与隔离测试无需加载，也不得拿真实配置做夹具

## 按任务打开

| 文档 | 什么时候打开 |
| --- | --- |
| [开发约定](docs/development.md) | 改代码、测试或项目文档前；包含验证、测试隔离、命名与 Git 流程 |
| [架构与契约](docs/architecture.md) | 查模块职责、产品边界或跨模块契约；改对应域前只读相关节 |
| [README](README.md) | 查改用户承诺、命令行为或使用示例 |
| [覆写配置详版](docs/overwrite.md) | 查改覆写的用户语法与示例；不是内部实现约定 |
| [安全说明](SECURITY.md) | 查改安全边界、漏洞报告方式或支持范围 |
| [重构待办](docs/todo.md) | 正要改对应域，需要核对刻意推迟的结构性重构 |
| [worktree 收尾](.claude/commands/wt-done.md) | worktree 改动提交后，合入 main 并清理 |
| [发布流程](.claude/commands/release.md) | 用户明确要求发布时 |

## 需要查证时再打开

| 文档 | 什么时候打开 |
| --- | --- |
| [架构决策](docs/decisions.md) | 需要某条决策的背景、理由或拒绝过的替代方案；先用文内主题索引定位 |
| [现行结论与边界](CONCLUSIONS.md) | 涉及相关实测结论、已知风险或验证边界；改到对应代码时同步更新 |
| [CHANGELOG](CHANGELOG.md) | 查用户可见版本历史或补当轮变化；[归档](docs/changelog/CHANGELOG-archive.md) 不作为现行约定加载 |

代码注释只写判据与契约，历史叙事不进注释。当轮验证过程与测试计数留在提交信息，不复制进现行文档
