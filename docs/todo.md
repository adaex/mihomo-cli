# 重构待办

只记已评估、刻意推迟的结构性重构：单项收益小或不紧迫，攒到下次动到对应域时顺路做。做完删条目，不保留完成记录（历史进 git）。新增条目写清动机与触发条件，避免变成愿望清单；行数、文件数、调用数会漂移，不写进条目

## 代码

- **settings.ts 两段同构读取共享**：readSettings 与 readSubscriptionCache 都是「读 JSON + 形态校验 + ENOENT 特判 + 损坏备份」，靠注释互指对齐。抽共享骨架（校验谓词参数化），消除注释对齐。触发：下次给 settings 或 cache 加第三种持久化文件时
- **spawnSync 捕获分类习语收口**：各调用点分别做 error/status null 分类与退出码判读。可提共享 runCapture，但各处退出码语义不同（pgrep 0/1、launchctl 113/112/125、pkill 0/1/2/3），抽象层必须让语义留在调用点。触发：下次新增 spawnSync 调用点时先建 helper 再用
- **service.ts 启动侧三处锁内临界区同构收口**：installService/startService/restartService 各有一段「epoch 判定 → enable → bootstrap」锁内块，仅标志变量名、what 文案、enable 容错三处差异。抽 helper 返回「是否被并发 stop 取消」；这是 D3 锁预算的关键执行体，改动时先同步 service-concurrency.spec 的预算断言。停止侧 stopService/uninstallService 的同形块已抽 `bootoutAndDisableInLock`。触发：下次动 service 锁内调用链时
- **overwrite.ts 按现有消费边界增量拆分**：操作符合并、文件加载与展示已是不同消费域，修改对应功能时可先抽其中一段并随迁测试；不得拆散 D7 的合并/诊断双路径、统一排序和 `selectActiveOverwriteFiles` 闸门，避免调用方重新拼装安全顺序。触发：下次改覆写合并或加载布局时
- **service.spec 中 launchctl / stop-epoch 用例归位**：该文件目前还覆盖相邻模块，改动时把对应用例迁到 launchctl.spec / stop-epoch.spec，保留现有 colocated 形态，不新建根级 tests 目录。触发：下次改这些用例或其被测模块时
- **内核存在性与版本探测抽成 kernel-probe**：探测位于 config.ts，kernel.ts 又反向消费；下次改探测逻辑时抽独立小模块，config 只保留原生配置校验，不顺手重写 kernel。触发：下次改内核版本或存在性探测时
- **doctor 复用的 npm 查询迁出 commands/update**：版本查询与 env 恢复目前和 update 命令流程同文件，doctor 直接复用 peer command；下次改 npm 查询或代理恢复机制时抽核心模块，保持 update 与 doctor 共用同一实现。触发：下次改 D9/npm 查询时
