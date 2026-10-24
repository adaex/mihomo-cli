# 重构待办

只记已评估、刻意推迟的结构性重构：单项收益小或不紧迫，攒到下次动到对应域时顺路做。做完删条目，不保留完成记录（历史进 git）。新增条目写清动机与触发条件，避免变成愿望清单；行数、文件数、调用数会漂移，不写进条目

## 代码

- **hot-reload.ts 合并回 service.ts**：全仓唯一消费方是 service.ts，合并不成环（它多出的 proxy-probe/settings 两条边本就是 service 的依赖面）。触发：下次改 service 拆分布局时
- **process-start.ts 归位到 runtime 域**：唯一消费方是 runtime.ts，且它反向 import service——名字与 process-probe/process-stop 同族但域属「TUN 启动」而非通用进程。改名或并入 runtime 旁。触发：下次动 TUN 启动链路时
- **settings.ts 两段同构读取共享**：readSettings 与 readSubscriptionCache 都是「读 JSON + 形态校验 + ENOENT 特判 + 损坏备份」，靠注释互指对齐。抽共享骨架（校验谓词参数化），消除注释对齐。触发：下次给 settings 或 cache 加第三种持久化文件时
- **spawnSync 捕获分类习语收口**：各调用点分别做 error/status null 分类与退出码判读。可提共享 runCapture，但各处退出码语义不同（pgrep 0/1、launchctl 113/112/125、pkill 0/1/2/3），抽象层必须让语义留在调用点。触发：下次新增 spawn 调用点时先建 helper 再用
- **utils.ts（只剩 sleep）撤编**：sleep 并入最高频消费方后删模块。触发：上面任一重构顺路时
- **service.ts 三处锁内临界区同构收口**：installService/startService/restartService 各有一段「epoch 判定 → enable → bootstrap」锁内块，仅标志变量名、what 文案、enable 容错三处差异。抽 helper 返回「是否被并发 stop 取消」；这是 D3 锁预算的关键执行体，改动时先同步 service-concurrency.spec 的预算断言。触发：下次动 service 锁内调用链时
- **token 查重守卫单点化**：registry.ts 的 COMMAND_INDEX 构建与 shared.ts 的 assertUniqueTokens 是同一判据两份实现。参数化后 registry 复用 shared。触发：下次改命令注册表或子命令表时
- **带值选项扫描循环收口**：parseIntArg（argv.ts）、parseMirrorArg/parseProxyArg（kernel-args.ts）三处各写一份「遍历 token → matchValueFlagToken → 收集命中 → 判重复」骨架，且 mirror 处不跳值、proxy 处跳值，细节已现分歧。提 collectFlagValues 到 flags.ts，三个解析器只留值语义校验。触发：下次新增带值选项时
- **isPlainObject 形态守卫单点化**：「非 null 非数组的对象」谓词散落在 settings、config、overwrite。提一个类型谓词统一替换。触发：下次新增持久化 JSON 形态校验时
- **overwrite.ts 按现有消费边界增量拆分**：操作符合并、文件加载与展示已是不同消费域，修改对应功能时可先抽其中一段并随迁测试；不得拆散 D7 的合并/诊断双路径、统一排序和 `selectActiveOverwriteFiles` 闸门，避免调用方重新拼装安全顺序。触发：下次改覆写合并或加载布局时
- **service.spec 中 launchctl / stop-epoch 用例归位**：该文件目前还覆盖相邻模块，改动时把对应用例迁到 launchctl.spec / stop-epoch.spec，保留现有 colocated 形态，不新建根级 tests 目录。触发：下次改这些用例或其被测模块时
- **内核存在性与版本探测抽成 kernel-probe**：探测位于 config.ts，kernel.ts 又反向消费；下次改探测逻辑时抽独立小模块，config 只保留原生配置校验，不顺手重写 kernel。触发：下次改内核版本或存在性探测时
- **doctor 复用的 npm 查询迁出 commands/update**：版本查询与 env 恢复目前和 update 命令流程同文件，doctor 直接复用 peer command；下次改 D9/npm 查询时抽核心模块，保持 update 与 doctor 共用同一实现。触发：下次改 npm 查询或代理恢复机制时

## 基建（可选）

- **去 tsx 换 Node 原生 type stripping**：Node 原生已支持类型擦除，但本仓 import 用 `.js` 扩展指向 `.ts` 文件、原生不重写扩展名，需全仓机械改写 + `allowImportingTsExtensions`。收益仅省一个 devDep，除非哪次大重构顺路，否则不做
- **轻量 import 结构断言**：下次新增核心模块时，考虑用无第三方依赖的静态 import spec 断言「非 commands 生产模块不得 import commands（index 除外）」与「生产运行时 import 图无环」。只锁依赖边界，不冻结文件清单、行数或模块职责；当前没有真实循环依赖，不为此单独迁移模块
