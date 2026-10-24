---
description: 发布新版本 mihomo-cli（检查清单、CI Trusted Publishing、发布结果核实）
argument-hint: [版本号]
---

发布 mihomo-cli $ARGUMENTS。本地准备版本、验证并推送；`.github/workflows/publish.yml` 在版本 tag 推送后通过 npm Trusted Publishing（OIDC）发布，并在成功后创建 GitHub Release。不在本地或 GitHub Secrets 保存长期 npm token

## 版本号规则：年.月.序号（如 26.9.90）

- **年.月**取发布当日的日历（两位年），**序号**是**全局发布计数**——从 npm 上全部历史版本延续、**永不重置**：本次序号 = `npm view mihomo-cli versions --json` 的数组长度 + 1
- 计数记账：26.9.37 是第 89 个发布、但序号误取了当月计数（37），已 deprecate；自 26.9.90（第 90 个发布）起序号与全局计数对齐
- 年月与序号都只增，semver 比较天然反映发布先后，`compare-versions` 与 npm 均按普通三元组处理，无需特判

## 一次性：npm Trusted Publisher 绑定

在 npmjs.com 的包设置中打开 **Trusted publishing**，添加 **GitHub Actions**：

- Organization / username：`adaex`
- Repository：`mihomo-cli`
- Workflow filename：`publish.yml`（只写文件名，不写 `.github/workflows/` 路径）
- Environment：留空；workflow 未使用 GitHub deployment environment
- Allowed actions：允许直接 `npm publish`；不开放独立的 dist-tag 管理

这些值区分大小写，必须与 GitHub 仓库和 `.github/workflows/publish.yml` 完全一致。仓库与包保持公开，`package.json` 的 `repository.url` 指向同一仓库；新绑定需在 2 天内完成首次成功发布，否则会过期。修改绑定时删除旧配置后重建

CI 使用 GitHub-hosted runner、npm CLI >= 11.5.1 与 `id-token: write`。Trusted Publishing 自动生成 provenance，不再传 `--provenance`，也不配置 `NPM_TOKEN`

## 发布前检查清单

- [ ] `npm run typecheck`、`npm test`、`npm run check` 全绿；检查输出确认 `Checked N files` 且 N > 0，warn/info 已逐条审阅
- [ ] 所有新增功能已在 README 或其链接的用户文档中说明；每类复杂行为只有一个详版，不在多处复制规则
- [ ] 命令列表与 `src/commands/registry.ts` 实际注册一致
- [ ] `CHANGELOG.md` 顶部已添加新版本记录，且每条控制在 1–3 句
- [ ] 若本轮改了 CONCLUSIONS 记录的结论或边界涉及的代码，同步更新该文档对应节
- [ ] 版本号定得对：序号 = registry 全部版本数 + 1（`npm view mihomo-cli versions --json` 数组长度 + 1），年.月 按发布当日日历
- [ ] `git log vX.Y.Z(上一个)..main` 过一遍——**发布区间可能含上轮遗留的未发布提交**，CHANGELOG 要覆盖它们，不只是本次会话做的事
- [ ] npm Trusted Publisher 绑定仍存在且允许 `npm publish`；GitHub 的 `publish.yml` 已合入 main

命令列表那条不用肉眼比对 README，直接把注册表打出来：

```bash
npx tsx -e "
import { allCommandTokens, findCommand } from './src/commands/registry.ts';
const commands = [...new Set(allCommandTokens().map(token => findCommand(token)))];
for (const c of commands) if (c) console.log([c.name, ...c.aliases].join(', ').padEnd(46), c.usage.length ? '(有 usage)' : '(无 usage)');
"
```

注册表只包含当前支持的命令与别名；「无 usage」的快捷命令（tun）由主命令的用法行覆盖。本轮未改注册表时可跳过这项

## 步骤

1. 更新 `package.json` 中的 `version`；`npm install --package-lock-only` 让 lock 的 version 跟上，避免 package 与 lock 版本漂移
2. `CHANGELOG.md` 顶部添加新版本记录（新增/变更/修复/安全 分组），**每条 1–3 句**：写改了什么、用户会看到什么变化、必要时一句根因；按用户可见变化组织，不按审查轮次组织。当轮实测耗时、差分组数、反向验证与测试计数留在提交信息；长期边界与教训收进 CONCLUSIONS，稳定判据留在 CLAUDE 与代码注释。主文件超过 10 个版本小节时，把最旧整节**原样**搬进 `docs/changelog/CHANGELOG-archive.md`，不改写历史
3. 检查并更新 README 及其链接的用户文档（新增功能、命令变更、示例）
4. 执行 `npm run typecheck && npm test && npm run check && npm run build`，再完成下方产物自检。CI 的 `prepublishOnly` 会在 tag 源码上重新验证，不以此替代本地检查
5. 逐文件核对 `git status --short`，只显式暂存已确认的发布相关文件（禁止 `git add .` / `git add -A`）；用 `git diff --cached --stat` 复核后提交：`git commit -m "chore: 发布 vX.Y.Z"`
6. 推送 main：`git push`
7. 打 tag 并推送：`git tag -a vX.Y.Z -m "…"`，然后 `git push origin vX.Y.Z`。tag 触发 Publish workflow，**不要在本地执行 `npm publish`**
8. 用 `gh run list --workflow publish.yml --limit 1` 找到本次 run，再 `gh run watch <run-id>`。`publish` 任务负责 npm，`release` 任务仅在成功后按 CHANGELOG 创建 GitHub Release
9. 核实 `gh release view vX.Y.Z` 与 workflow 结果；若 npm 已成功而 `release` 任务失败，只重跑失败任务，不要重复整个发布 workflow

tag 与 GitHub Release 让每个 npm 版本对应到确定源码；发布时立即创建，不能省略

## 发布结果核实

**CI 的 `npm publish` 成功即视为发布成功，不等 CDN 落地。**

registry 的 CDN 同步可滞后数分钟：期间版本文档与产物 URL 都是 404、`npm view` 的 `latest` 仍是旧版本、重跑发布会得到 `409 Cannot publish over previously staged version`（staged ≠ published，说明还在处理队列）。这些都不是失败信号，不必守着等它变 200，也不要盲目重跑整个 workflow

若确实需要确认某个版本已对外可见（比如要通知别人升级），再查：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/mihomo-cli/X.Y.Z
```

200 即已落地。重跑发布得到 `403 You cannot publish over the previously published versions` 同样是已落地的证据

## 产物自检：别把「publish 没报错」当成「发出去的东西能用」

`prepublishOnly` 只保证验证与 build 跑过，不保证 tarball 里的东西对——`dist/` 被 gitignore，版本号来自 `package.json`，`files` 字段决定装进去什么。本地与 CI 都要核对 tag、`package.json`、`dist` 版本一致，并检查 tarball 内容

**build 之后、推送 tag 之前**，至少执行：

```bash
MIHOMO_CLI_DIR="/tmp/mihomo-cli-pack-smoke-$$" \
MIHOMO_CLI_DAEMON_LABEL="com.mihomo-cli.pack-smoke-$$" \
node dist/index.js version    # 必须是本次要发的版本，不读取真实数据目录或服务
npm pack --dry-run            # 确认 dist、README、LICENSE、CHANGELOG、SECURITY、docs/overwrite.md、package.json 齐全
```

若本轮改动有用户可见的行为变化，值得在发布之后从 registry 把产物拉回来实跑一遍（CDN 落地后）——这是唯一能覆盖「打包漏文件」的检查：

```bash
cd /tmp && mkdir vp && cd vp
npm pack mihomo-cli@X.Y.Z && tar -xzf mihomo-cli-X.Y.Z.tgz
MIHOMO_CLI_DIR=/tmp/vp/data MIHOMO_CLI_DAEMON_LABEL="com.mihomo-cli.pack-smoke-$$" node package/dist/index.js version
# 再选本轮改动验证；所有服务操作都必须保持一次性 label 与临时目录隔离，避免触碰用户 LaunchAgent
```

完成后清理临时目录、进程与测试 plist
