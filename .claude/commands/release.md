---
description: 发布新版本 mihomo-cli（检查清单、步骤、发布结果核实）
argument-hint: [版本号]
---

发布 mihomo-cli $ARGUMENTS（语义化版本：主.次.修订）。发布不经 CI，所有验证在本地完成。

## 发布前检查清单

- [ ] `npm run typecheck && npm test && npm run check` 全绿
- [ ] 所有新增功能已在 `README.md` 中说明
- [ ] 命令列表与 `src/commands/registry.ts` 实际注册一致
- [ ] `CHANGELOG.md` 顶部已添加新版本记录
- [ ] 若本轮改了 `CODE_REVIEW.md` 涉及的代码，同步更新该文档（基线、单测数、未处理项）

命令列表那条不用肉眼比对 README，直接把注册表打出来：

```bash
npx tsx -e "
import { COMMANDS } from './src/commands/registry.ts';
for (const c of COMMANDS) console.log([c.name, ...c.aliases].join(', ').padEnd(46), c.usage.length ? '(有 usage)' : '(无 usage)', c.hidden ? '[hidden]' : '');
"
```

`[hidden]` 的是墓碑命令与过渡别名（`daemon`/`up`/`down`/`log`），本就不该在 README 里；「无 usage」的是纯别名（`tun`、`use`），由主命令的用法行覆盖。本轮没动注册表就跳过这条，别每次都重头核一遍。

## 步骤

1. 更新 `package.json` 中的 `version`
2. `CHANGELOG.md` 顶部添加新版本记录（格式参照既有条目：新增/变更/修复/安全 分组）
3. 检查并更新 `README.md`（新增功能、命令变更、示例）
4. `npm run build`（`prepublishOnly` 已兜底，此步为提前验证）
5. 提交：`git add . && git commit -m "chore: 发布 vX.Y.Z"`
6. `npm publish`
7. `git push`

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

**build 之后、publish 之前**，至少验证产物自身报的版本号：

```bash
node dist/index.js version    # 必须是本次要发的版本，不是看 package.json
```

若本轮改动有用户可见的行为变化，值得在 publish 之后从 registry 把产物拉回来实跑一遍（CDN 落地后）——这是唯一能覆盖「打包漏文件」的检查：

```bash
cd /tmp && mkdir vp && cd vp
npm pack mihomo-cli@X.Y.Z && tar -xzf mihomo-cli-X.Y.Z.tgz
MIHOMO_CLI_DIR=/tmp/vp/data node package/dist/index.js version
# 再挑本轮修的行为跑一两条，用 MIHOMO_CLI_DIR 隔离，别碰 ~/.mihomo-cli
```

v4.7.5 就是这样验的：三处修复各在发布产物上复现了一遍（带序号归档能列出、`reset --full` 后 settings.json 不重建、持锁瞬间锁文件落在数据目录根下）。**注意锁文件正常释放后即删，静态 `ls` 看不到**，要在持锁期间高频扫描才能观察到落点。用完删掉 `/tmp/vp`。
