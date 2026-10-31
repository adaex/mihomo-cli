# 开发约定

模块职责、产品边界与跨模块契约见 [架构与契约](architecture.md)

## 验证命令

```bash
npm run typecheck && npm test && npm run check && npm run build
```

- 不把裸 `npm run dev` 当验证命令：它会操作真实数据目录、查询真实服务，status 还会探测网络并加载用户覆写脚本的顶层代码。需要 smoke 时用 `makeFixture` / `runCli`，或显式隔离 `MIHOMO_CLI_DIR` 与 `MIHOMO_CLI_DAEMON_LABEL`
- Biome 管格式与 import 排序；`npm run check` 的输出必须确认 `Checked N files` 且 N > 0，warn/info 也要逐条看，不能只看退出码。只需检查源码时可用 `npx biome check src/`
- 验收命令不接管道收尾（`npm test | tail` 的退出码是 tail 的）：红会被吞成 0，要截断输出就重定向到文件再看
- 删除或更名导出后全仓搜索（含测试内嵌脚本与 Markdown 示例）；typecheck 看不到字符串里的 import

## 测试与夹具

- 测试用 node:test + tsx，命名 `*.spec.ts`；验证行为与数据最终状态，不用实现清单断言代替
- 端到端夹具统一收在 `src/test-support/`，不在各 spec 重抄 spawn 与 env：
  - `cli.ts`：`makeFixture` / `runCli` / `readEpochIn` / `ENTRY`，模块级子进程 `runModule` / `moduleUrl`；CLI 夹具自带临时 `MIHOMO_CLI_DIR`、一次性 label、`NO_COLOR` 三件套
  - `fake-kernel.ts`：假内核落盘、起进程、等出现、判死、收尾；禁静态 import 模块加载期固化 DIR 的模块
  - `guard.ts`：守卫类 preload spawn 骨架，env 整体替换以表达「刻意不设 DIR」形态
  - `stub-bin.ts`：PATH 桩可执行文件原语
  - `stub-curl-env.ts`：桩 curl 记录 no_proxy 实见值的回归闸夹具
  - `spawn-eval.ts`：异步 `tsx -e` 子进程原语，并发用例的 spawn 形态
  - `poll.ts`：同步轮询原语，跨进程文件信号的统一等待骨架
- 跨进程并发用 spawn 并行验证，spawnSync 顺序跑验不了
- 异步子进程用 `spawnEval` 的默认 20 秒超时兜底，调用方仍必须在 `finally` 清理自建进程，不能把超时当常规收尾
- 验证依赖 HOME、临时目录或定制 env 的行为时，优先写成 `*.spec.ts` 并通过子进程 env 显式传值，留下可复查的隔离前提与回归测试；不要为了绕过工具权限提示而降低验证要求

## 隔离与反向验证

- 进程类测试必须先隔离再有副作用：临时 `MIHOMO_CLI_DIR`，涉及服务/reset 再加一次性 `MIHOMO_CLI_DAEMON_LABEL`；`killLeftovers` 必须先经 `assertIsolatedCleanupPattern`，guard 失败时任何 `pkill` 都不得发生。`runCli` / `runModule` 的隔离键不允许被 env 覆盖；涉及 plist 的服务测试还要临时 HOME 和 PATH launchctl 桩
- 修完必做反向验证：还原修复，确认用例转红，规则见 [D11](decisions.md#d11-测试纪律反向验证与失败安全隔离)。预测落空处是认知与实现的偏差点，补不变量用例挡在结构层

## 命名

- 帮助与内部命名用全称单数（subscription/directory/overwrite），示例与提示用 `mihomo-cli sub` / `dir` / `ow`；内部变量函数全称单数，常量全大写下划线
- `dir open` 精确匹配 root/subs/logs/data/runtime/kernel

## 文档归属

- 代码注释只写判据与契约，历史修复叙事留在 CHANGELOG/git，不复制进现行文档
- CHANGELOG 只写用户可见变化，每条 1–3 句，不按审查轮次组织；当轮验证过程与测试计数留在提交信息。长期边界收进 CONCLUSIONS，发布与归档细则由 [发布流程](release.md) 持有

## Git 与流程

- 默认在 `.claude/worktrees/` 工作，创建前 fetch；创建后先核对基线与本地 main，落后则先 `git merge --ff-only main`，再重读待编辑文件（工具默认基线可能是 origin/main，而本地 main 有未推送提交）。首次验证前在 worktree 内执行 `npm ci`，不得依赖父目录偶然可解析的 node_modules
- 不需要 Co-Authored-By；提交前用 `git status` 逐文件核对改动归属，避免混入并行代理未提交的工作
- worktree 内全部提交并确认干净后，退出 worktree（保留分支）并回主仓合入：先 `git merge --ff-only <分支>`；main 已前进时用 cherry-pick 或 rebase，不用 `--no-ff`。cherry-pick 后用 `git diff <分支> main --stat` 核对树内容，不能只看 git log
- 确认无遗漏后立即 `git worktree remove` + `git branch -D`，并核实临时目录、一次性 label 的 plist 与自建进程已清理
- 文档冲突保留双方的用户可见变化、实测结论与现行约定
- 发布仅在用户要求时执行，按 [发布流程](release.md)
