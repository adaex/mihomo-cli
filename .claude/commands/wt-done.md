---
description: worktree 改动合并进 main 并就地收尾清理
---

把当前 worktree 的改动合并进 `main`，然后就地完成收尾清理。纪律：**合并后立刻清理，不用等人催**。

## 步骤

1. 确认 worktree 内所有改动已提交（`git status` 干净）
2. 退出 worktree：`ExitWorktree`（保留分支）。若当前会话本就不在 worktree 内（如前一会话中断、由新会话接手收尾），该步是 no-op，直接在主仓合并
3. 合并到 `main`：先试 `git merge --ff-only`；若 `main` 期间有了新提交，用 cherry-pick 或 rebase，**不要 `--no-ff` 制造无谓的合并提交**
4. cherry-pick 会生成新哈希，`git log main..<分支>` 仍显示「未合入」——用 `git diff <分支> main --stat` 比对树内容判断是否真的合入，不是看 `git log`
5. 确认无遗漏后：`git worktree remove` + `git branch -D`
6. 核实临时产物已清：`/tmp` 下的测试数据目录、一次性 label 的 LaunchAgent plist、自己起的进程

## 注意

- 合并时若 worktree 与 `main` 改了同一处文档，**保留双方的实测结论**——它们通常是各自独立验证出来的，丢掉任何一条都是白跑一次验证
- **多个并行 worktree 分支都往 CHANGELOG、CLAUDE.md 或其导航文档写条目时**，逐个 cherry-pick 会反复撞同一处冲突：解冲突时保留双方的用户可见变化与现行约定，不把各分支的综述、轮次或测试计数拼进 CHANGELOG。发布前用 `git log v上版..main --oneline` 逐条核对 Unreleased 覆盖面；当轮验证过程与测试计数留在提交信息
- 要验证依赖 `HOME`、临时目录或定制 env 的行为，优先写成 `*.spec.ts` 并通过子进程 env 显式传值：隔离前提可复查，也能留下回归测试。不要为了绕过当前工具的权限提示而改写命令或降低验证要求
- **会话里有后台代理并行改同一工作区时，提交前先 `git status` 逐文件核对改动归属**，别把代理已完成未提交的工作混进自己的提交（git add -A 是重灾区）；已混入就如实在提交消息里注明，或 reset 后重新分提交
