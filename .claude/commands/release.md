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
