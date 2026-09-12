---
description: 发布新版本 mihomo-cli（检查清单、步骤、发布结果核实）
argument-hint: [版本号]
---

发布 mihomo-cli $ARGUMENTS（语义化版本：主.次.修订）。发布不经 CI，所有验证在本地完成。

## 发布前检查清单

- [ ] `npm run typecheck`、`npm test`、`npm run check` 全绿；worktree 下显式 `npx biome check src/`，检查数量不能为 0
- [ ] 所有新增功能已在 `README.md` 中说明
- [ ] 命令列表与 `src/commands/registry.ts` 实际注册一致
- [ ] `CHANGELOG.md` 顶部已添加新版本记录
- [ ] 若本轮改了 `CODE_REVIEW.md` 涉及的代码，同步更新该文档（验证范围、结果与未处理项）
- [ ] 版本号定得对：有新命令或新选项走 minor，纯修复走 patch
- [ ] `git log vX.Y.Z(上一个)..main` 过一遍——**发布区间可能含上轮遗留的未发布提交**，CHANGELOG 要覆盖它们，不只是本次会话做的事

命令列表那条不用肉眼比对 README，直接把注册表打出来：

```bash
npx tsx -e "
import { COMMANDS } from './src/commands/registry.ts';
for (const c of COMMANDS) console.log([c.name, ...c.aliases].join(', ').padEnd(46), c.usage.length ? '(有 usage)' : '(无 usage)');
"
```

注册表只包含当前支持的命令与别名；「无 usage」的快捷命令（tun、use）由主命令的用法行覆盖。本轮未改注册表时可跳过这项

## 步骤

1. 更新 `package.json` 中的 `version`；`npm install --package-lock-only` 让 lock 的 version 跟上（长期漂移过一次：lock 停在 4.7.1 而 package.json 已是 4.7.7）
2. `CHANGELOG.md` 顶部添加新版本记录（格式参照既有条目：新增/变更/修复/安全 分组）
3. 检查并更新 `README.md`（新增功能、命令变更、示例）
4. `npm run build`（`prepublishOnly` 已兜底，此步为提前验证）
5. 提交：`git add . && git commit -m "chore: 发布 vX.Y.Z"`
6. `npm publish`
7. **打 tag 并推送**：`git tag -a vX.Y.Z -m "…"`，然后 `git push` + `git push origin vX.Y.Z`
8. **建 GitHub Release**：正文取 CHANGELOG 对应小节

```bash
# 从 CHANGELOG 提取本版本小节作为 Release 正文
python3 - <<'EOF' > /tmp/rel.md
import re
V = 'X.Y.Z'
md = open('CHANGELOG.md').read().split('\n')
starts = [i for i, l in enumerate(md) if re.match(r'^## \[', l)]
begin = next(i for i in starts if md[i].startswith(f'## [{V}]'))
end = next((i for i in starts if i > begin), len(md))
print('\n'.join(md[begin+1:end]).strip())
EOF
gh release create vX.Y.Z --title vX.Y.Z --notes-file /tmp/rel.md
```

**第 7、8 步不能省。** v4.8.0 之前 78 个 npm 版本一个 tag 都没有——外部无法定位任何版本的源码，`git diff` 做不到，CHANGELOG 的记录指不到代码。补录时才发现「取该版本最后一个提交」这种想当然的规则会让 10 个 tag 指向发布之后才写的代码（当时 main 上已有未发布的重构），只能靠 npm 的 publish 时间戳反推落点。**发布时顺手打 tag 是一秒钟的事，事后补是考古。**

## 发布结果核实

**`npm publish` 不报错即视为发布成功，就此收工，不等 CDN 落地。**

registry 的 CDN 同步可滞后数分钟：期间版本文档与产物 URL 都是 404、`npm view` 的 `latest` 仍是旧版本、重跑 `npm publish` 会得到 `409 Cannot publish over previously staged version`（staged ≠ published，说明还在处理队列）。这些都**不是**失败信号，只是还没同步完，不必守着等它变 200。

若确实需要确认某个版本已对外可见（比如要通知别人升级），再查：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/mihomo-cli/X.Y.Z
```

200 即已落地。重跑 `npm publish` 得到 `403 You cannot publish over the previously published versions` 同样是已落地的证据。

## 产物自检：别把「publish 没报错」当成「发出去的东西能用」

`prepublishOnly: npm run build` 只保证 build **跑过**，不保证 tarball 里的东西对——`dist/` 被 gitignore，版本号来自 `package.json`，`files` 字段决定装进去什么，这几处任一出错，`npm publish` 都照样成功。这正是本仓「报告成功前必须独立确认」那条纪律的发布版本。

**build 之后、publish 之前**，至少验证产物自身报的版本号，并看一眼 tarball 装了什么：

```bash
node dist/index.js version    # 必须是本次要发的版本，不是看 package.json
npm pack --dry-run            # 确认 files 字段的产物齐全（dist/README/LICENSE/CHANGELOG/package.json）
```

若本轮改动有用户可见的行为变化，值得在 publish 之后从 registry 把产物拉回来实跑一遍（CDN 落地后）——这是唯一能覆盖「打包漏文件」的检查：

```bash
cd /tmp && mkdir vp && cd vp
npm pack mihomo-cli@X.Y.Z && tar -xzf mihomo-cli-X.Y.Z.tgz
MIHOMO_CLI_DIR=/tmp/vp/data node package/dist/index.js version
# 再选本轮改动验证；涉及服务时还须隔离 MIHOMO_CLI_DAEMON_LABEL，避免触碰用户 LaunchAgent
```

完成后清理临时目录、进程与测试 plist
