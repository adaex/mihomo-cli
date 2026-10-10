# 重构待办

记已评估、刻意推迟的结构性重构：单项收益小或不紧迫，攒到下次动到对应域时顺路做。做完删条目，不保留完成记录（历史进 git）。新增条目写清动机与触发条件，避免变成愿望清单。

## 代码

- **hot-reload.ts 合并回 service.ts**：121 行、全仓唯一消费方是 service.ts，合并不成环（它多出的 proxy-probe/settings 两条边本就是 service 的依赖面），换 service.ts 回到 ~800 行。触发：下次改 service 拆分布局时
- **process-start.ts 归位到 runtime 域**：182 行、唯一消费方是 runtime.ts，且它反向 import service——名字与 process-probe/process-stop 同族但域属「TUN 启动」而非「进程」。改名或并入 runtime 旁。触发：下次动 TUN 启动链路时
- **settings.ts 两段同构读取共享**：readSettings 与 readSubscriptionCache 都是「读 JSON + 形态校验 + ENOENT 特判 + 损坏备份」，靠注释互指对齐。抽共享骨架（校验谓词参数化），消除注释对齐。触发：下次给 settings 或 cache 加第三种持久化文件时
- **spawnSync 捕获分类习语收口**：13+ 处各自写 `result.error || status === null` 分类与退出码三分法。可提共享 runCapture，但各处退出码语义不同（pgrep 0/1、launchctl 113/112/125、pkill 0/1/2/3），抽象层必须让语义留在调用点。触发：下次新增 spawn 调用点时先建 helper 再用
- **utils.ts（只剩 sleep）撤编**：sleep 并入最高频消费方后删模块。触发：上面任一重构顺路时

## 基建（可选）

- **去 tsx 换 Node 原生 type stripping**：Node ≥22.18 原生支持，但本仓 import 用 `.js` 扩展指向 `.ts` 文件、原生不重写扩展名，需全仓 60+ 文件机械改写 + `allowImportingTsExtensions`。收益仅省一个 devDep，除非哪次大重构顺路，否则不做
