# Changelog

## [26.10.102]

### 变更（第十九轮全量质量清理：/simplify 四角度）

- **锁定键剥除收口为单一执行集**：「实际被剥除的锁定键 = LOCKED_CONFIG_KEYS + tls」此前在常量表、脚本探针、config.ts 的手写三段扫描加独立 `delete tls`、快照测试里各抄一份（tls 是 external-controller-tls 证书来源、属控制面但不进上游 Inbound 快照表）。现统一为 constants.ts 的 `EFFECTIVELY_LOCKED_KEYS`：YAML 告警扫描经新纯函数 `lockedKeysReferencedBy`（操作符形态与表外 tls 同判），剥除循环、脚本快照探针、快照测试全部派生自这一份，新增锁定段只改一处
- **残留清理结果成为机制的一部分**：`cleanupKernelsOrThrow`/`stopService`/`uninstallService` 改为返回 cleanupAll 的 `CleanupResult`，stop/uninstall/reset 消费同一份复核结果，不再在清理之后重发 pgrep；reset 服务活跃路径删掉第二次 cleanupAll（旧实现多一次 pgrep 与 5s 死亡等待、root 脚本失败时可能再要一次密码，并把同一条 warn 打印成「进程目前已不在」与「可能仍有残留进程」两份互相矛盾的说法），warn 渲染统一为 `warnResidueCleanup` 一个出口
- **`--mirror` 收编进选项登记表**：flags 的 `takesValue` 扩为 `false | 'required' | 'optional'`，可选值选项的词法（exact/等号/裸写边界）随登记表走；argv 白名单的 `--mirror=` 特判、kernel 命令的局部 valueFlags 表、parseMirrorArg 的手写计数与等值判定三处旁路删除，parseMirrorArg 只保留镜像值归一化（别名/https/direct）
- **版本查询出网决策收口**：cmdKernel 与 doctor 各自手拼的「代理在跑经代理、无代理走 gh、direct 全绕」决策合并为 kernel.ts 的 `resolveReleaseQuery`（与下载通道决策同源输入）；下载兜底路径的反推函数保留，两处对「显式镜像无代理」的不同答案（gh 认证 vs 直连）由成对用例锁定为刻意分歧
- **运行模式规整在入口**：新增 `RuntimeMode` 类型（下沉 types.ts），buildConfig/judgeScriptMatches/prepareConfigForStart 形参收紧，两处 `mode === 'tun' ? 'tun' : 'mixed'` 归一删除；start/status 的 `TUN`/`Mixed` 标签统一走 `runtimeModeLabel`
- **复用与简化**：doctor 的代理连通性探测改为与 `mihomo -t` 配置校验并行发起（代理不通时体检少等约 2s，展示顺序不变）；节点计数三处合一（`countConfigNodes`）、pgrep/lsof 的 pid 输出解析合一（`parsePidList`）、端口合法性判据三处合一（`isValidPortNumber`）、scheme 前缀正则四份合一；shortOverwriteName 移回 overwrite.ts（扩展名知识与文件名判定同源派生，JS 扩展名再加不会漏展示侧）；序号两位对齐改 `padStart(2)`；订阅 URL hostname 解析两处合一；另清理死字段 `OverwriteFileInfo.error`、不可达守卫、恒等分支、不可达默认参数、游离 JSDoc 与服务健康结果的四处重复字面量。行为不变（942 测试全绿）

### 变更（第二十轮全量质量清理：/simplify 第二巡，四角度）

- **进程探测合面**：存活/属主/命令行/内存四个事实统一为一次 `ps -ww -o pid,uid,rss,command`（`probeProcess`），清理残留时每个 pid 最多 4 次串行 ps 降为 1 次；死亡等待在有 pid 列表时改用 `process.kill(pid,0)` 无 spawn 轮询（等待中 Ctrl+C 不再被每轮 pgrep 阻塞），终态结论仍一律以 pgrep pattern 复核为准
- **同拍 launchctl 查询去重**：TUN 启动前复核的装载态透传给 pkill 前复核、重启分支的服务状态透传给热重载探测，各省一次 launchctl print
- **删除零命中的进程内探测缓存与一批死字段**：连通性探测的 3s 缓存对单命令短进程没有第二个读端（跨进程不共享内存，「连敲第二次免等」不成立）；DownloadResult 的 4 个元数据字段、AutoUpdateResult、StartResult、StopResult 的恒真字段、覆写三类条目的 path、日志轮转的计数返回值均无消费者，删除
- **单点收口**：并发判据 6 个调用点统一为零参数的 `startAbortedByConcurrentStop`；curl 错误末行、两端口安全读取、status 生效覆写谓词、TUN 阻断 hint 各收口一处；TUN 阻断按语境分两个标题（入口＝服务在跑、复核＝另一终端并发拉起）。端到端测试夹具统一进 `src/test-support/cli.ts`，13 个命令 spec 不再各抄 spawn 与隔离 env。行为不变（942 测试全绿）

## [26.10.101]

### 功能（JS 覆写脚本命中约定）

- **脚本 `return true` = 命中当前订阅**：脚本没有 match 声明，status 的「生效/不适用」此前对脚本永远报生效——作用域不中的脚本混在生效清单里，与「match 不命中的 YAML」同一种误读。约定刻意最简：判据过了在函数末尾 `return true`，其余（提前退出、无返回值）一律未命中；严格 `=== true`，返回 config 等对象不算（防「顺手 return」被误读）。判定只供展示、不参与合并闸门（selectActiveOverwriteFiles 不看它）：status 文本行与 `--json` 的 `applied` 据此把未命中脚本列进「不适用（脚本未返回 true）」，config 提示段给一行事实性提示（不断言「没改配置」）；status 用活跃订阅的缓存正文跑一次真实构建取判定，构建失败按未判定降级（诊断面不崩，D7 同款姿态）。README 脚本示例与契约、CLAUDE.md 不变量、decisions.md D13 尾段同步更新

### 修复与评审（命中判定的诊断面收口）

- **status 判定改走独立旁路（judgeScriptMatches），不再经 buildConfig**：后者吃 loadOverwriteFile 硬失败门，一个坏 YAML 会把全部脚本的判定打回「未判定＝生效」——恰是判定要消灭的误读、且坏文件在场时正是最需要判定的时刻（评审实验复现）。判定复用 listOverwriteFile 同一次读目录的 ok 条目（新 entries 字段），近失文件名的 stderr 警告不再打两遍、YAML 不再解析两次；无脚本的目录直接跳过判定（不为空判定白跑一次订阅解析）。两个降级语义均有回归用例（坏文件在场判定不降级、警告恰好一次），均反向验证
- **mode 推导判据收敛为 deriveRuntimeMode**（config/status/doctor 三处共用；runtime.ts 的 getRuntimeMode 带服务安装前置条件、不属同一判据）：防止三份 `info?.tun ? 'tun' : 'mixed'` 拷贝将来漂移，脚本按 ctx.mode 得到矛盾的生效结论
- **文档承诺同步**：README「变换函数执行中抛错」条目改为如实描述（status 的判定构建会执行函数体、把执行失败按未判定降级）；`ow` 列表的脚本行补 return true 约定提示（用户从 status 的「脚本未返回 true」跳到 ow 排查时能看到改法）；types.ts 的 OverwriteTransform 契约注释与类型签名（`void | true`）对齐

### 变更（全量质量清理）

- **doctor 与日常命令的重复探测收口**：一次体检原先对服务状态跑三遍 launchctl 查询、对同一内核二进制连 spawn 三次 `-v`，现在各查一次（新增 probeKernelVersion，可执行性判据与版本提取共用一份正则，doctor 检查项、内核下载自检、版本对账三处同源）；短帮助、热重载、stop 等路径的冗余子进程一并收口，体检更快、口径单点维护
- **散在各命令的提示与守卫收口**：遗留服务清理的前后提示、杀不掉进程的手动清理命令、「订阅有条目但没有本地配置文件」「未找到内核」等此前各写一份且已漂移出多种说法的提示/报错，统一为单点维护的共享出口；个别场景的提示更完整（uninstall 的遗留清理提示补齐密码说明、订阅配置缺失的指引统一带「更新订阅:」前缀）
- **类型与死代码清理**：覆写 match 类型收窄为恒数组（加载时已归一，消费侧三处永假的防御分支删除）；maskUrl 迁入 text.ts（底层 HTTP 模块不再反向依赖设置模块），其「token 黑名单键不重复」断言原先埋在 try 内会被当畸形输入吞掉、现落成独立测试；内核下载通道的三元判别、服务停止的锁内序列复制、损坏文件备份的双份同构实现等十余处简化，行为不变（全量测试锁定）

## [26.10.100] - 2026-10-02

### 文档（第十七轮：文档冗余与归档专项）

- **README 六处冗余/漏登收口**：快速开始的 kernel 命令块与「内核更新通道」节高度重复，收敛为一条并指向详节；「示例」节两个内容相同的 YAML 覆写示例合一；删除与上文重复的孤立句；`sudo pkill -9 mihomo` 补误杀警示（会连用户自建 mihomo 实例一起杀）；相邻安全条目的重复尾句收拢；「选项写法」长短对应表补 `-p`/`--proxy` 行、status 行补全 `[-j|--json]`（与 config 行同屏一致）
- **CODE_REVIEW 头部清理**：堆积的 12 条历轮流水违反该文档自身「流水不在此堆放」原则，清至只保留最近一条；三条仍有效判定（第八轮两条「记录不修」、第十四轮三个文件级失败的持续观察）打捞进正文对应节
- **CHANGELOG 归档**：4.x 全系与误序的 26.9.37 共 29 个小节移入 docs/changelog/CHANGELOG-archive.md，主文件 163 KB → 44 KB（CHANGELOG 随 npm 包分发）

### 重构（第十五轮：过度设计专项审查）

- **删四项无论证的复杂/冗余**（其余复杂度逐一核对均有事故背景，未动）：①`getLogPath()` 纯转手 `PATHS.logFile`（唯一调用方直写，同文件其余三处本就直用 PATHS）；②`maskUrl`→`maskSingleUrl` 的 1:1 转发层内联（多源合并功能 e090618 删除后遗留的空壳，空串守卫经逐值推演冗余——catch 分支原样返回）；③service.ts 两个类型 re-export 无任何消费方（拆分「保持导出清单不变」原则下的多余项，typecheck 与全仓 grep 双重确认零消费）；④logs 列表逐条「查看:」行删除（尾部六行用法尾注已完整覆盖同一信息，归档 5–10 条时同一提示打 N+1 遍）
- 自查六维度零过度信号：模块规模分布健康（最大 878 行为核心复杂度所在）、全仓唯一 `opts?` 参数化有测试理由、依赖 2+7 全在用、工具链/CI 与本地管线逐字一致、基础设施模块消费方匹配、types.ts 44 个类型全是领域实体；别名面克制（19 个命令仅 6 个带别名）

### 修复与测试（第十四轮：高负载偶发失败根因 + 脱敏短串例外 + 文案一致性）

- **锁用例的跨进程时刻标记改按「数字就绪」读取（测试自身的竞态，withFileLock 本体无缺陷）**：两个锁用例轮询「文件存在即读」，而 writeFileSync 的 open→write 非原子——高负载下子进程被抢停在两者之间时主进程读到空文件，`Number('') === 0` 让时刻断言拿 0 与真实时间戳比较，误报「子进程在放锁之前拿到锁」（4 轮全量 2 轮失败、量化复现 912+1）。抽 waitForMoment（读到完整数字串才算就绪），补确定性用例（空文件即该窗口的稳态形态、判据行为直接断言），反向验证降级即红
- **maskUrl 降级路径删掉「短串例外」**：≤30 的畸形串原样返回，误把整条 token 当 URL 粘入（`sub add <token>`）时凭据全量进错误消息（downloadSubscription 调用方证实可达）；截断阈值 30 → 15，泄漏上限与前缀保留量对称。反向验证回 30 即红
- **文案一致性 11 处**（首次系统过全部用户可见串）：`检查到`→`检测到`（错字）；「mihomo-cli 内核/进程」→「mihomo 内核/内核进程」（内核是 mihomo，旧称名不副实）；TUN 侧配置缺失对齐服务侧形态（补命令 hint）；`config -j` 帮助补全（registry 与 README 两处，对齐 `status` 的 `[-j|--json]` 写法）；README doctor 表格行补「内核与」；logs 用法行片段顺序两处统一；data 目录 label 改「运行数据目录」（「mihomo-cli 数据目录」与数据根目录同屏撞名且打破「X目录」模式）；logs 用法块内括号全半角统一

### 修复与测试（第十三轮：定向 fuzz + 覆盖盲区盘点 + 发布前对账）

- **maskUrl 畸形输入的降级路径不再展示尾部**：无法解析的长串原「前15...后10」截断会把 token 尾段（位于 query/尾部）带进错误消息——改保头舍尾（scheme/host 在头部，排错线索保留、凭据尾段不泄）。fuzz 抓出（合法 URL 200 万级组合已验证长值/userinfo 100% 被遮，仅降级路径有此弱点）
- **补五个测试盲区**（盘点结论：无死代码、其余未测均为纯展示派生不值得凑数）：TUN 启动脚本观察窗契约（12×0.1s 窗内死亡退 2 清 pid、存活退 0 落真实 pid——注释实录的 180/540ms 漏报与僵尸误判事故首次有回归护栏，含反向验证）；「探测失败 ≠ 未装载」消费点（print 退 112/125 抛错、113 是唯一合法未装载答案）；cmdUninstall 幂等判据（四条件全空零写动词/plist 缺失仍装载走 bootout/游离内核给 PID）；入口自指代理清除接线（自指清除、他端口保留、损坏 settings 按默认口判定）；`logs 0` 无日志时退出码透传
- 发布前对账：npm audit 0 漏洞；npm pack 产物 5 文件无开发机路径泄漏；dist 与 tsx 21 命令行为逐字等价；git 全史敏感信息扫描干净（候选均为 fixture 占位符）；CHANGELOG 与 16 commit 对账全覆盖；parseIntArg 20 万组 fuzz 不变量成立

### 文档（第十二轮：decisions.md 与实现现状逐条对照）— 补录（本轮对账发现漏记）

- decisions.md 五处滞后修正：D4「TUN 不消费基线」实质过时（现为 bump 后重捕获）、D5 常量实际住址、D3 拆分后指向、D6 措辞如实化、D5 补 tls 表外旁路半句；核心结论「四轮大修未违反任何决策的精神」。发布前对账全绿（npm audit / pack 产物 / doctor 耗时 / tsconfig strict）

### 修复与测试（第十一轮：README 承诺面对照 + 测试假阳性抽验 + 真实链路实测）— 补录（本轮对账发现漏记）

- **README 五处不同步收口**：ow on/off 重启透传选项未写、kernel 参考表缺 `--proxy`、「内存占用」限定 TUN 模式、启动失败示例缺末行；`sub add` 用法行 `<url>` 改 `[url]`（**实现侧**补齐：交互下不带 URL 自动读剪贴板，文档原本写成了必填）
- http.spec 两条恒真/错位断言修复（纯垃圾 fixture 对截断与否全绿，换合法 JSON 判别 fixture 并反向验证）；kernel.spec 白名单用例补「curl 零调用」排序断言；fchmod 落位与 restartService label 校验两个既修项补零覆盖用例（均反向验证转红）
- 真实链路实测通过：内核下载全链（真网络 19.8 MB → 真内核自检 → 版本对账 → 原子替换）、JS 脚本重建 proxy-groups、脚本改锁定键被剥除且告警、YAML `+rules` 前插落在脚本产出后（D13 顺序）

### 修复（第十轮终审：独立 agent 审第九轮 diff + 主仓冒烟实测）

- **re-export 收窄补齐**：第九轮提交声称收窄 7 个符号、实际只删了 2 个（其余 5 个留在 launchctl 的 re-export 块里）——终审以 a9ca602 基线比对抓出，公共契约面现真正与拆分前一致；三条失实声明（提交信息/CHANGELOG/CODE_REVIEW）已更正
- **atomicWriteFileSync 内改用 fchmod 落定权限**：fchmod 作用于 fd、不受 umask 掩蔽，mode 是调用方契约（plist 0644）不随用户 shell 的 umask 漂移；installService 的事后 chmodSync 随之删除（无 0600 中间窗口）
- **restartService 入口补 assertServiceLabelSafe**：kickstart 与锁内 enable+bootstrap 不经 startService 的断言，非法 label 会静默作用于默认 label（既存缺口，constants.ts 新括注把它说成全覆盖时暴露）
- **paths.ts 的 stage 注释两处 copyFileSync 旧措辞残留**（机制描述已按原子写更新）
- 冒烟实测通过：空环境全命令面、错误路径、空串口径（sub/ow/dir/logs）、sub 列表与 config 的脱敏出口、dist 产物可执行

### 修复（第九轮复审：自查 + code-review 过第八轮合入批次）

- **reset 的确认后并发复核补齐 legacy sudo 窗口**：重读原在 legacy 清理之前，清理的密码窗（约 60s）内并发 `install && start` 仍会漏停漏卸、删 kernel 后落 KeepAlive 崩溃循环；重读挪到清理之后，窗口闭合
- **installService 落位后补显式 chmod 0o644**：原子写的 open(2) mode 受 umask 掩蔽（umask 077 下实际 0600），改原子写时丢了原 chmodSync 的权限保证
- **`logs ""`（空串编号）显式报错**：空串经 getNonFlagArg 返回 `''` 而非 null，被当缺省静默落列表——空串口径（`sub ""` 等已修）的最后同族漏网
- **parseIntArg 的漏值形态诊断**：`-n -n` / `-n -n 200` 按「需要正整数」报错，不再误报「只能指定一次」（用户会去找并不存在的重复项）
- **mirror 前缀未作用时不再打矛盾的「经镜像中转」提示**；警告补改用 gh 通道的指引
- **runtime.ts 修注释错位**（startCommandForCurrentMode 插进了并发复核注释块与函数之间，两段 doc 叠放）；**五处过时/违规注释**（timer 预算范围、stage 原子写、拆分后的位置论证、历史叙事删除、行号自引）
- **service.ts re-export 面收窄**：拆分时意外扩大的导出面收回（7 个零消费符号，首轮收窄仅 2 个、终审补齐其余 5 个），公共契约面与拆分前一致

### 修复（第八轮复审）


- **`sub` 列表的面板 URL 脱敏**：`web_page_url`（服务器可控的 `profile-web-page-url` 响应头）常带机场自动登录 token，此前唯独常驻列表原样上屏，其余 URL 出口均已脱敏
- **https→http 降级守卫的错误消息脱敏**：token 常被服务器保留在重定向查询串里，恰在该守卫要防的攻击形态下经「获取订阅失败：」前缀明文带出（后面补的 URL 反而是掩码）
- **空白/纯注释覆写文档不再硬失败**：js-yaml 5 对其抛「expected a document」而非返回 null（js-yaml 4 行为，注释即按它写的），落入 catch 把「先建空骨架再编辑」的自然操作顺序当坏文件让 start/config/doctor 失败；恢复「不计入任何一边」的承诺
- **带值选项重复给出显式报错**：`start -u 5000 -u 70000` 此前静默取 5000（后写的没生效，正是「以为生效了」的红线形态），口径对齐 kernel 的 `--mirror`/`--proxy`
- **reset 确认后重读服务状态**：交互确认等待无上界，期间另一终端 `install && start` 装上服务的话，按确认前快照判定会既不停也不卸载、直接删 config/kernel 目录，KeepAlive 对已删文件落入崩溃循环；与 start 的「快照 + 现值」双读同姿态
- **直连 fetch 超时翻译为超时语义**：不再裸抛「This operation was aborted」（与 curl 路径的退出码翻译对称）；外部 signal 的中止保持原样
- **doctor 版本比较补脏数据守卫**：latest 非 semver（私有 registry）按 skip 渲染，体检不被击穿（与 update 的 resolveUpdateAction 同口径）
- **installService 原子落位**：copyFileSync 直写 `~/Library/LaunchAgents` 被打断会留半截 plist、launchd 静默不加载；改 tmp+rename
- **热重载的 abort 预算不再被前置 launchctl 查询分食**：timer 起表移到第一个 fetch 前；launchctl 病态慢时热重载不再恒降级为完整重启（代理瞬断）；三处只读 running/loaded 的状态查询省掉 print-disabled
- **崩溃清扫名单补 `runtime/check-*` 与 `service.plist.stage`**（均仅 finally 清理，SIGKILL 即永久残留）
- **`sub remove` 对未命中报错**：并发删除下不再对没删的东西报「已删除」（removeSubscription 返回 `{found, switchedTo}`）
- **doctor 的坏订阅名不击穿体检**：手改 settings 的非法订阅名包成 fail 检查项继续跑完
- **hasGh 探测加 3s 超时**（防 wrapper 挂死入口）；**pickLatestRelease 补滤 `-rc` 后缀**（上游未勾 prerelease 位时版本对账必炸）；**mirror 遇非 github.com 资产地址点破「镜像未起作用」**（上游迁移资产 host 后不再静默退化直连）
- **空串子命令与空串编号显式报错**：`sub ""` / `ow ""` / `dir ""` / `logs ""` 不再静默落列表；空命令 token 的纠错建议不再全命中（纯噪音）
- **ow 用法行补 `[-s] [-u ms]`**（与 onUnknown 报错、sub use 三处两个说法）；**prepublishOnly 补全 typecheck+test+check**（红色测试不再能随发布出门）

### 测试

- **补安全关键闸门的零覆盖缺口**：`downloadKernel` 下载后完整性闸门（大小对账/自检/版本对账/白名单/原子替换，子进程 + 桩 curl/gzip 端到端）、`assertTrustedAssetUrl` 单测、`assertLooksLikeSubscription` 写闸（错误 JSON 拒收且原文件不动/服务端消息透出/provider-only 放行）、http 大小上限三道（声明预拒/流式中止/错误体限量）、`waitUntilUnloaded` 耗尽抛错与 `disableServiceAutoStart` 位未生效复核（「谎报停止」的两条唯一闸门）、`commands/log.spec.ts`（编号省略默认当前日志/归档序号映射）——以上全部做过反向验证（破坏防线确认用例转红）
- **修 waitServiceHealthy 用例的隔离违规**：原用真实 `PATHS` 拼 pgrep pattern，开发机自己的内核在跑时假红/飘（违反 D11）；改子进程 + MIHOMO_CLI_DIR 并断言隔离前提

### 重构

- **service.ts（1205 行）按职责拆四节**：launchctl.ts（解析与状态读取）、stop-epoch.ts（停止计数与并发基线）、legacy-cleanup.ts（遗留 root 清理与残留分档）、hot-reload.ts（热重载探测与结论）；service.ts 剩服务生命周期本体（~630 行），全部旧导出经 re-export 保持，全仓 import 不变，纯移动零行为变化
- cmdStop 服务路径复用 handleStopResult；getControllerPortOrNull 收拢 status/ui 同构降级；startCommandForCurrentMode 收拢三处重启命令推导；doctor 的 withTimeout 改名 withAbortableTimeout（与 errors.ts 同名异构区分）

## [26.10.99] - 2026-10-02

### 变更（breaking）

- **命令入口收敛为 `mihomo-cli` + `mh`**：`mihomo` / `mhm` 别名移除——`mihomo` 与内核二进制同名，两个包管理器的全局 bin 会互相覆盖。从旧版升级后旧的 `mihomo` / `mhm` 链接由 npm 自动清理；全文命令示例与提示文案统一改用 `mihomo-cli`

### 修复

- **doctor 不再把面板自升级的旧内核备份当「残留」告警**：上游升级器成功后**有意永久保留** `meta-backup`（旧内核副本，供回滚，已核对上游源码），此前它与中断暂存 `meta-update` 合并成一条 warn——面板里正常升级一次内核，doctor 从此每次都报「自升级残留」，且按提示修复会把回滚备份一并删掉。现拆为两项：`meta-update` 存在才是真残留（升级被中断），warn 并给只删暂存的命令；`meta-backup` 按信息项列出、给独立的可选清理口径
- **kernel 帮助的通道顺序与实际一致**：帮助仍写旧顺序「gh > 本机代理 > 直连」，而实际已是本机代理优先、gh 回退——按 help 排障会被反向误导
- **显式指定通道下载失败不再报统一话术**：`--mirror` / `--proxy` / `--mirror direct` 只有单条候选，失败时统一抛「全部下载通道均失败」既掩盖原始错误（HTTP 错误/低速/超时）又给不适用的换节点指引；现以原始错误为主消息，只附改用其他通道的出路
- **`mihomo-cli update`/`doctor` 的 npm 此前同样吃不到本机代理**：shell 里 `export https_proxy` 指向自己的 Mixed 端口（Mixed 用户的常见终端配置）时，入口 D9 清除后 npm 直连 registry——代理明明在跑，手动 `npm install -g` 能成、CLI 包装的 update 反而失败。现清除时登记原值，npm 每次 spawn 前 TCP 探活被指端口：在监听（内核在跑）才把用户原配置 per-spawn 注回，端口不活（env 残留、内核已停）保持清除；不凭空注入（没用 env 代理的用户路径不变，用户 .npmrc 配置优先于 env），doctor 的版本检查同路径受益
- **内核下载的 gh 回退此前实际走了直连**：v26.10.98 的设计是 gh 回退与首选通道同经本机代理（「只换客户端不换路径」），但入口 `clearProxyEnv`（D9）会清掉指向本机 Mixed 端口的代理 env——shell 里 export 了 `https_proxy` 的最常见形态恰好被清，gh 回退实际直连 GitHub，两条通道低速失败时「手动换节点」的诊断也随之失准。现 gh 回退候选由通道决策带上本机代理地址，下载时只给该子进程注入代理环境变量（不写全局 env；内核下载中途不重启自己的代理，不违反 D9），通道行与失败汇总显示真实路径
- **TUN 启动增加并发复核**：此前 sudo 密码窗（最长 60 秒）期间另一终端执行 `stop`，TUN 仍会照常启动——终态与用户最后一条命令相反；并发 `start`（mixed）在密码窗完成引导也会被 TUN 脚本误杀内核。现启动前复核停止计数与服务装载态，被并发停止即取消（命令层关闭自启后重捕获基线，自己的递增不误判）
- **`mihomo-cli config` 对坏订阅不再渲染堆栈**：订阅内容解析失败（语法错/空/顶层非映射）改走 CliError 统一渲染，与「预期错误不带堆栈」的口径一致
- **流量行不再漏出 `NaN%`**：手工改坏的订阅缓存（如 `download: "oops"`）此前让百分比除法漏出字面 NaN——与「未知」口径对齐，非有限值不挂百分比分片
- 上游入站锁定清单对照 v1.19.32 重新核对（无字段集差异，快照基线刷新；上游默认分支变更的事实与影响评估记入 CODE_REVIEW）
- README 安装节补 Node.js >= 22.22.1 前置要求
- **健康轮询宽限期与观察窗同兜底**：第二阶段（宽限窗）launchctl 查询全失败时，不再拿第一阶段末尾的陈旧「未运行」快照当结论——进程探测兜底与第一阶段同一判据
- **凭据脱敏补 hysteria2 realm-opts 的 `token`**（realm 认证令牌）
- **update 版本决策不再裸奔**：抽纯函数 `resolveUpdateAction` 并补测试（领先拦截/已最新跳过/落后继续/查询失败降级/非 semver 五路），`getLatestNpmVersion` 补桩 npm 三态用例
- `config` 展示的终端安全锁结构用例：js-yaml 对控制字符一律转义，dump 输出无原始控制字节（防止未来换序列化实现或新增绕过 dump 的展示形态时静默引入注入面）
- **终端消毒漏剥 `\r`**：服务器可控字符串（内核校验输出里的节点名、机场错误页、订阅头解析值）携带回车符时可回行首覆盖已输出内容，伪造 `✗` 为 `✓`；现 C0 控制字符剥除与函数注释承诺一致
- **凭据脱敏补 hysteria2 `obfs-password` 与 hysteria(1.x) `auth`**：`mihomo-cli config` 不再明文输出混淆密码与旧版认证字段
- **遗留 root 服务清理删 plist 不验收**：`rm -f` 静默失败仍报「已清理」，plist 残留会在下次开机被 launchd 重新加载（KeepAlive 幽灵复活）；现删除后复核存在性，失败报错并给手动清理命令
- **健康轮询不再把 launchctl 瞬时失败报成「启动失败」**：`waitServiceHealthy` 轮询期间查询失败按「本轮未知、继续观察」处理，窗口内始终查询失败给出诚实结论；`start` 收尾的状态展示失败降级为警告，不再让启动成功以退出码 1 收场
- **help 页别名与快捷命令补齐**：`命令别名` 行列出全部入口名，快捷命令节补上 `use <name>` 与 `restart`（此前仅 README 可见）
- **`sub add <url> -名字` 报错引导对齐**：argv 层对 `-名字` 形态的报错指明「订阅名不能以 `-` 开头」，不再只报「该命令不接受任何选项」
- `settings.json` 脱敏黑名单去除重复登记的 `api_key`（零行为影响），补枚举不重复的结构断言

### 内部

- 多候选下载中途切换通道时带上失败原因首行（此前原因只在全部失败分支可见，中途成功就永远看不到）；downloadKernel 兜底版本查询的出网方式抽 resolveFallbackQueryOptions 与下载通道对齐（direct 与无代理 mirror 绝不经 gh api）；gh 探测只在结果参与决策的形态执行（`--mirror direct`/`--proxy` 不再白花一次同步子进程）；删除零调用的 `resolveDownloadChannel` 导出；direct 通道不再多打孤立空行，失败汇总的「本机代理/经本机代理」措辞与通道头部行一致
- help.spec 补整页帮助的别名行（列出全部入口）与快捷命令节（tun/use/restart）断言；log.ts 归档文件名注释修正；`mihomo-cli ui` 的运行态查询无容错记入 CODE_REVIEW（纯打开操作、失败重跑成本为零）
- `OverwriteScriptContext.warn` 注释修正为现行口径：仅 `start`/`config`/`doctor` 可见，`status` 走诊断旁路不执行脚本
- sudo 密码窗口（spawnSync 最长 60s）期间 Ctrl+C 无响应的已知权衡记入 CODE_REVIEW

## [26.10.98] - 2026-10-02

### 新增

- **doctor 检查面板自升级残留**：在面板里升级内核（`POST /upgrade`）后，内核会在 kernel 目录留下 `meta-backup`（旧内核备份），异常中断时还会遗留 `meta-update`（下载暂存）；doctor 会提示目录位置、区分两者性质（备份可留作回滚、暂存可安全删）并给出删除命令

### 改进

- **内核下载本机代理优先、失败自动换通道**：`mihomo kernel` 在本机代理运行时默认经代理下载，失败自动回退 gh；全部失败时汇总各通道原因，并提示可在面板手动换节点。显式 `--mirror`/`--proxy` 仍严格按指定通道、不自动切换
- **劣质节点下载不再长时间干等**：节点握手延迟低但实际带宽极低时（实测约 20 KB/s），此前 gh 通道会卡满 210 秒；现代理通道在 20 秒内平均速度低于 50 KB/s 即快速失败，gh 通道超时也缩短到 100 秒。超时或低速失败给出可读原因，不再只显示「curl 退出码 28」

## [26.10.97] - 2026-10-01

### 修复

- **sudo 执行超时不再漏出内部错误串**：密码提示停留或脚本执行超过 60 秒时，此前用户看到的是 `spawnSync sudo ETIMEDOUT`，现改为超时提示并点明操作可能只完成了一部分
- **覆写 match 值加载期校验补齐**：`url-domain` 带协议、尾斜杠、端口、空格，或 `name` 精确值含非法字符时，文件会静默永不生效，现一律加载时报错；`rules!+`、`+~rules` 等操作符漏网形态同样拦下
- **帮助文案与实际行为对齐**：logs 用法行更正裸命令语义、version 用法不再内嵌别名、subscription use 补上自动重启说明；子命令名（如 `sub USE`）改为大小写不敏感
- **到期时间戳对非法值返回「未知」**：手工改坏缓存（非数字、负数、超出日期上限）时此前漏出字面 `Invalid Date` 或 1970 日期

## [26.10.96] - 2026-10-01

### 修复

- **裸 `-` 一律按未知选项报错**：此前被 argv 校验豁免、取位置参数时又跳过，两头不认等于静默丢弃——`sub update -`（短横线笔误）会被当成无参形态批量更新全部订阅，`start -` 静默起默认代理，`sub add <url> -` 更会建出 remove/use 都无法指定的订阅（只剩 reset 能收拾）
- **pid 文件清理免提权**：文件在 runtime/ 下（用户属主目录），目录可写即可删其中任意文件、与文件属主无关——root 属主的 TUN 残留文件也直接删，不再走 sudo rm。此前零进程的 `mihomo stop` 会为一个没有进程读的无害文件弹管理员密码（取消后还警告「未能清理」，而文件随后就被免提权的 runtime 清理删掉）；sudo 清理脚本被取消后也不再紧接着弹第二次密码
- **进程还活着时不再删 pid 文件**：sudo 清理被取消、root TUN 内核仍在路由时，pid 文件是 status/isRunning 的真相源——免提权化初版在此场景把它删掉，status 从此对活着的内核报「未运行」；现改为复核确认进程清零后才清理
- **legacy 迁移脚本不再删活进程的 pid**：清理旧 v3–v4 root LaunchDaemon 的脚本在 `bootout` 后无条件 `rm pid`，机器残留旧 plist（检测只看文件存在）却另有一个无关活 root TUN 时，bootout 返回 113（未装载）仍会删掉活 TUN 的 pid——之后并发 `mihomo status` 对仍在路由的内核误报「未运行」，此刻 Ctrl+C 凝固成「活 TUN + 无 pid」。脚本不再碰 pid，改为拆除成功、复核进程清零后免提权清理；有并存的活 TUN 时保留其 pid
- `mihomo reset` 遇 root 残留清理的 sudo 未走通（取消/非 TTY/脚本失败）时不再完全静默：进程复核已清空则继续重置，但黄字告知可能有残留未清及重试入口（26.10.95 统一后该场景的警告通道被丢弃）
- `mihomo stop` 收尾警告归因修正：进程在死亡等待内自行退光、而 sudo 清理脚本被取消/失败时，旧逻辑把它说成「root 属主的 pid 文件未能清理」（文件可能根本没出过问题），现按「清理未完成、进程目前已不在」归因；两类收尾错误（脚本/pid 文件）拆为独立字段，服务路径的提示同步按字段分开
- 残留清理报错不再把 surviving 进程一概说成「root 属主」：没进过 root 分支（用户态 SIGKILL 未能终止）时按「用户态未能终止」描述，root 断言只跟随 sudo 脚本失败出现；pid 文件清理失败的文案也不再断言「root 属主」（免提权 unlink 失败与属主无关），且「用户态残留 + pid 文件小错」不再被拦成命令失败（错误消息会是 unlink 报错、与「进程未终止」的提示自相矛盾），归外层残留处置
- pid 文件清理失败的警告不再连打两遍（clearPid 内部遗留的 console.warn 与调用方警告叠加）；sudo 失败短语全仓统一为 describeSudoFailure（非鉴权错误保留原始消息——非交互环境的具体原因不再被「sudo 执行失败」笼统盖掉），pid 文件短语统一 describePidCleanupFailure
- 空环境裸 `mihomo sub remove`（未给名称）改报「没有订阅」，与带名称形态及 use/update 同口径（旧报「请指定名称」并引导补一个不存在的参数）
- 混合属主时 root 残留清理的预告只列 root 属主的 PID：用户态游离内核混在其中时，旧消息把全部 PID 都标成「root 属主的内核残留」，与实际属主不符

### 内部

- root 残留清理脚本 buildKernelCleanupScript 不再 `rm pid`：cleanupAll 路径的 pid 删除统一在末尾、复核 remaining 为空才免提权 unlink，消除该路径「活进程不删 isRunning 真相源」在提权脚本内的字面例外（此前仅靠「sudo 取消脚本不执行 + pkill 失败 exit 2」两道时序间接保证；legacy 迁移脚本 buildLegacyCleanupScript 的同款 `rm pid` 也已收口，见上方修复段）；buildRootResidueCleanupError 在 scriptError 与 pidError 并存时改为 scriptError 优先（主归因「清理未走完」、pid 错误仅附带，手动命令给 pkill 而非 rm，防漏掉潜在存活进程）；reset 的警告理由去掉 `as Error` 断言、改显式空值守卫；补「脚本不得含 rm」的结构断言、只读文件免提权删除与双错误并存象限用例
- `CleanupResult.sudoError` 拆为 `scriptError`（pkill 脚本）与 `pidError`（pid 文件删除）两个字段：进程死光但脚本没走完与仅 pid 文件残留是两种归因，合并字段让调用方提示说错事；处置判据 classifyResidueCleanup 同步（throw 档只看 scriptError，pidError 不参与拦截），reset 的警告判据也收口到它
- `StaleState` 删除无消费方的 `needsSudo`/`hasRootPidFile`/`hasRootProcess` 字段；`clearPid` 的三态返回值（cancelled/failed/null）随免提权化收敛为 `Error | null`
- 覆写数组拼接误用的「值类型描述」抽为 describeValueKind：文件级（系统默认值）与合并级（订阅现值）两处检查共用，消除已漂移的双实现
- 测试注释清理：三处历史叙事（引入版本、旧实现去向）改为只留判据，历史留在 CHANGELOG/git

## [26.10.95] - 2026-10-01

### 修复

- **README 承诺的覆写反例现在真的报错**：`log-level+: warning`（数组操作符作用于系统默认的标量键）此前静默产出 `log-level: [warning]`，配置一路存活到内核 `-t`——类型检查只看得到订阅层，而该键只存在于系统默认配置（在合并之后才注入）。现在文件加载阶段即报错并给出改写指引
- **坏覆写文件在 `ow` / `status` 的结论与启动硬失败不再自相矛盾**：`~dns` 这类已移除操作符此前在 `ow`/status 被列为「已生效」（`status --json` 的 `applied` 也带着它），而 `start`/`config`/`doctor` 对同一文件硬失败。操作符形态错误（`~`/尖括号/互斥/空键）提前到加载阶段校验，诊断与合并两条路径看到同一份坏文件清单；坏文件的修复/迁移指引（hint）此前只在启动报错时可见，现在 `ow`、status 文本与 `status --json` 都带出
- `mihomo status` 里 JS 覆写脚本的短名显示修复：`overwrite.js` 不再显示成 `js`（正确是「主文件」），`overwrite.dns.js` 不再带 `.js` 尾巴（26.9.93 引入脚本时漏改）
- `mihomo doctor` 订阅新鲜度不再输出「N 分钟前**前**更新」；未来时间戳（时钟偏移）单独显示「更新时间记录异常」
- 自动更新整体超时后，没赶上的订阅显示灰色「跳过（更新超时，使用本地缓存）」，不再与真实网络失败同刷红叉英文（`The operation was aborted...`），也不计入失败数——超时用缓存启动本是正常降级
- 内核下载/解压中被强制终止后，`kernel/.tmp-*` 临时目录（可能几十 MB）不再永久残留：与原子写 `*.tmp` 同受按 1 小时龄的崩溃残留清扫，旧内核完好时无需手动 `reset kernel`
- 空环境 `mihomo sub remove <名字>` 改报「没有订阅」，与 `use`/`update` 同口径（旧报「未找到匹配」）
- `mihomo start -u 5s` 等非法选项值现在先报参数错误，不再先撞「未找到内核」
- 服务路径清理 root 残留内核后偶发误报「部分进程未终止」（重跑一次又正常）消除：杀进程统一走带死亡等待轮询的同一实现，不再在发出 SIGKILL 后立刻复核 pgrep；三处 root 提权（start/stop/uninstall）前都补了「为什么需要管理员密码」的预告，不再无预警弹英文 `Password:`
- 非交互终端（或取消密码）下 `mihomo stop`/`uninstall` 不再因一个无害的 root 属主 pid 文件残留而整体失败：无残留进程时该文件清理失败只警告（无进程读它、下次自愈），与旧服务路径「无进程不弹密码」的语义对齐；root 进程确实没杀掉仍照常报错
- `uninstall` 不再重复执行第二次 disable（锁内已写入并经 `print-disabled` 复核成功，第二次必成功，纯冗余）

### 新增

- `mihomo reset overwrites` 完成后，若目录里还有不被加载的疑似覆写文件（`overwrite.yml`、`overwrite.ts`、大小写变体），点名告知「N 个疑似文件保留未删」及原因（保守起见这些近失文件仍不自动删）
- `mihomo kernel` 首选 gh 认证查询但回退直连成功时，打印一行实际来源（spinner 说的「gh 认证通道」与实际响应不再可能悄悄不一致）
- 连续查看状态时连通性探测结果按端口缓存 3 秒：代理不通时连敲 `status`/`doctor` 不再每次干等 2 秒（代理状态秒级不可能翻转；`--no-probe` 不受影响）
- README 修正 JS 脚本可见性描述：`ctx.warn()` 与脚本执行期抛错只在 `config`/`doctor`/`start` 可见，`status` 只加载脚本、不执行函数体

### 内部

- 残留内核清理收敛为唯一入口 `cleanupAll`（服务启停/卸载/重置/游离内核共用），删除 service.ts 内与之重复的约 100 行实现（`killResidualKernels`/`cleanupRootResidue` 等）；`cleanupAll`/`stop` 的 `forceSudo` 死参删除（无任何调用方传值）
- 删除 `withFileLock` 的 deadline 分支：过线后重新核对的还是循环顶部微秒前算过的同一个锁龄谓词，该分支永不产生行为差异；锁的心智模型回到「强夺唯一依据是锁龄」
- 健康轮询（每 100ms 一次、最坏 31 轮）不再白跑 `print-disabled`：健康判定从不读 disabled 字段，`getServiceStatus` 新增 `withDisabled` 选项，轮询关闭该查询以减少阻塞事件循环的 spawnSync；循环外从未被消费的首次快照一并删除
- 删除测试专用的第二合并入口 `deepMergeWithOverrides`，相关用例改走生产唯一入口 `applyOverwrite`

## [26.9.94] - 2026-09-30

### 破坏性变更（覆写执行顺序）

- **JS 覆写脚本改为在全部 YAML 覆写之前执行**：旧顺序下脚本整体重建数组（如重组 `proxy-groups`）会把 YAML 前插的组抹到末尾、声明式微调失效；新管线是脚本（只看到订阅配置）→ YAML 声明式合并 → 剥系统锁定项，YAML 的 `+key` 前插永远落在脚本产出之后。依赖「脚本读到 YAML 注入项」的覆写需把那段逻辑并入脚本；段内排序规则不变，`mihomo ow` 列表编号同步翻转，系统锁定项边界不受影响（论证见 decisions.md D13）。

## [26.9.93] - 2026-09-30

### 破坏性变更（覆写 DSL 裁边）

- **移除覆写操作符 `~key` / `~?key`（按 name 合并数组元素）与 `<key>` 尖括号转义**：`~` 是唯一「一句话说不清」的操作符（按 name 合并 + 「未命中追加/跳过」两态语义），历史上贡献过残缺分组事故；转义与配套的嵌套形似告警则服务不存在的键名形态。保留 `key!`（替换）、`+key`（前插）、`key+`（追加）三个纯数据操作符。**写这些旧形态现在直接报错并指向迁移路径，不会被静默当字面键名**。带条件的变换（按 name 找元素、改部分字段、找不到时跳过等）改用下面的 JS 脚本。
- **`match` 的 `subscription` 同义键收掉**：只认 `name`（语义不变），写 `subscription` 报错指明改名。订阅名通配收窄为两种形态：尾部 `*`（前缀，`edu*`）与头部 `*`（后缀，`*edu`），其余（`?`、多 `*`、中间 `*`、单独 `*`）报错——通用 glob 匹配器已删（曾实测把 CLI 挂死 70 秒），复杂匹配写 JS 脚本。

### 新增

- **JS 覆写脚本**（主脚本 `overwrite.{js,mjs,cjs}`、扩展脚本 `overwrite.*.{js,mjs,cjs}`）：默认导出一个函数，就地修改订阅 + YAML 覆写合并后的配置，返回值忽略。`ctx` 提供 `subscription`（name/url/预解析 host）、`mode`（mixed/tun）与 `warn(message)`（提示进 status/doctor/config 的 warnings 通道）。约定：必须同步（返回 Promise 报错）、全信任不沙箱（同 `.zshrc`）、系统锁定项（端口/控制面/allow-lan 等）照样剥除并告警、`ow off` 全局开关同样管脚本、坏脚本与坏 YAML 文件同款姿态（诊断面「加载失败」可见、start/doctor 硬失败）。加载顺序：YAML 全部在前、脚本在后。
- 迁移示例：原 `~?proxy-groups: [{name: Developer, default-selected: TW}]` 改为脚本 `(config['proxy-groups'] || []).find(g => g.name === 'Developer')` 后改字段、找不到 `ctx.warn` 跳过；原 `~proxies` 追加节点改 `'proxies+':`（数组追加）。README「覆写配置」章节已按新机制重写并附完整示例。

### 移除

- 删除 npm preuninstall 钩子设施（`scripts/preuninstall.mjs`、`lifecycle-script.spec.ts`、package.json 的钩子与 files 条目）：npm 11.19.0 实测三个卸载场景均不执行 uninstall 生命周期脚本，机制自始无效，与 v4.13.0 删补全子系统同一判据（设施规模与真实使用面不匹配）；README 卸载段早已不依赖该提醒。

### 内部

- CODE_REVIEW.md 从「历轮审查流水 + 现行边界」重组为纯现行边界文档（实测结论 / 未覆盖与待复核 / 已评估未采纳 / 自动化测试边界 / 平台实测备忘 / 流程教训六节）。367 行压到 121 行，流水里散落的现行结论（判定不修三项、原子写 fsync 的文件系统边界、文件锁 inode 缺口、订阅侧 `__proto__` 刻意不拦、remove 时序修复无自动化回归、pkill 自匹配对照实验、doctor 性能口径与网络取值不硬断言、顶层未知键无内核兜底、JSON stdout 契约、计时/负载/locale/spawnSync 死锁测试方法论）已并入对应节，历轮验证过程看 git 历史与当轮 CHANGELOG；release.md 的文档分工表与同步检查项、CLAUDE.md 的 Biome warn 级提醒同步更新。
- 结构整理一批（无用户可见行为变化）：`utils.ts` 按领域拆分为 argv/format/suggest/text/kernel-args 模块；重大决策论证从 CLAUDE.md 分层到 `docs/decisions.md`（D1–D11）；源码注释瘦身（历史叙事归 CHANGELOG/decisions，注释只留判据与契约）；并发停止基线统一由 main() 命令入口捕获为进程状态（D2/D4，取代参数透传）；内核版本探测移除进程内缓存。

## [26.9.92] - 2026-09-30

### 修复

- 两个终端同时 `mihomo start` 时，后到者不再报「启动服务失败（退出码 5）」——bootstrap 撞上先到者刚完成的任务时 launchctl 报 exit 5，与「disabled 标签」的报错完全同形（用户被指向错误的排查方向，服务实际健康在跑）；现在收到 exit 5 会复读服务装载状态，已装载按幂等成功处理，真失败（未装载）维持报错
- `mihomo sub remove` 删除正在运行实例所使用的订阅时给出重启提示：此前 active 静默切到下一条订阅，运行中的内核仍服务已删除订阅的旧配置，用户看到「已自动切换到 X」会误以为代理已在用 X（add/update 早有同款提示，唯独 remove 漏了）
- 覆写扩展文件的加载顺序不再随系统语言（locale）漂移：同一组文件在中文/英文机器上可能合并出不同的运行配置，全程静默；改为固定的码点序，并补了锁定用例
- `https_proxy=http://0.0.0.0:7890`（及 `0:`、`[::]:` 等未指定地址族写法）现在能被识别为「指向本机自己的 Mixed 端口」并在启动/下载前清除——macOS 上这类地址实际路由到回环监听器，漏识别时重启内核后下载仍经已死的代理出网（与此前修的裸 localhost 同族漏网）
- 订阅内容携带顶层 `__proto__` 键时 `mihomo config` 不再崩溃：此前脱敏副本的原型被静默换掉、键丢失，展示时抛裸异常按程序 bug 渲染
- `mihomo ui` 在 ports 配置写坏（如两端口相同）时照常打开并打印降级文案，不再整个命令硬失败（status 对同一场景早有降级，UI 此前漏了）
- `mihomo start tun` 检测到另一终端已启动 Mixed 服务时，不再先把在跑服务的日志搬去归档才拒绝——旧顺序下拒绝后 `logs 0` 会看不到服务的新日志（日志继续写进归档文件）
- `mihomo reset <目标> --full` 同时给出时改为报错，不再静默忽略目标、扩成全量重置（本意多半是「彻底删这个目标」，被放大到删设置/内核/服务远超预期）
- `mihomo reset config` 报「未知目标」——`config` 不再是 settings 的别名；它与 `mihomo config` 命令的运行配置直觉对撞，照原语义执行会删超预期的订阅列表/端口/密钥
- `mihomo kernel --mirror=`（等号空值）与 `--mirror ""` 报错，不再静默按默认裸域处理（与 `--proxy=` 姿态对齐；裸 `--mirror` 语义不变）
- 显式指定镜像的用户在版本查询失败时拿到可执行指引（检查代理 / gh 认证），不再只剩裸「更新失败」——提示压制条件本意是「别再建议镜像」，此前把真正的出路也一起吞了
- 订阅更新时缓存写入失败（如 cache.json 被手改成目录）现在回滚刚写入的订阅文件并给出带标签的报错——此前报「更新失败」但新配置已落盘，回执与终态矛盾，且错误是无指引的裸系统报错
- `install` 的 plist 暂存文件挪出运行时目录：安装期间另一终端 stop/reset 删除该目录会让安装以裸文件错误失败
- 订阅缓存读取补齐 ENOENT 分支：并发删除间隙不再误报「格式损坏」（与 settings 的同族修复对齐）
- 原子写遗留 `*.tmp` 的清扫挪到守卫与豁免判定之后、目录覆盖扩到根目录/subscriptions/runtime 三处（清扫是删除动作，不在被拒或豁免的命令上执行）

### 调整

- service.lock 内的 launchctl 调用统一单次超时 3s：并发 start 撞车的幂等处理给锁内新增了一次调用，最坏持锁时长按立项纪律压回强夺阈值（10s）以内——launchctl 响应慢于 3s 时快速失败并报错，不再持锁等待

## [26.9.91] - 2026-09-30

### 修复

- `start tun` 补上对并发 `start` 的防线（此前只有 mixed 侧防「stop 被 start 覆盖」，反方向裸奔）：TUN 分支确认服务停着后立即递增停止计数——慢速阶段（订阅更新 + sudo 密码窗口最长 60s）里另一终端 `start` 会在锁内检出变化而放弃启动；`startTun` 执行含 pkill 的 sudo 脚本前再复核一次服务装载状态，检出即中止，否则脚本会杀掉刚起的服务内核、KeepAlive 拉回后与 root TUN 内核互抢端口。
- 覆写文件写了 `match:` 但条件块缩进笔误（解析成空值）时不再静默全局生效，改为报错并给出正确写法——此前该文件会应用到**所有**订阅，笔误的垃圾键还进最终配置。
- `https_proxy=localhost:7890`（无协议、localhost 形态）现在能被识别为「指向本机自己的 Mixed 端口」并在启动/下载前清除：curl 与 gh 都认这个形态的代理 env，漏识别时重启内核后下载仍经已死的代理出网，正是这段清除逻辑唯一要防的死锁。
- 订阅缓存 cache.json 变成「合法 JSON 但不是对象」（如数组/数字）时先备份 `.bak` 再回退空缓存——与 settings.json 的既有处理对齐，此前下一次写缓存会把原件无声覆盖。
- sudo 脚本改写在数据根目录而非 runtime/：runtime 会被 stop/reset 整体删除，密码窗口内脚本被连带删掉的话，用户输完密码后 sudo 执行不存在的文件，错误被误诊成「密码错误」。
- 清理 root 属主 pid 文件的 sudo 分支超时对齐统一的 60s 并检查结果：此前自抄 10s，密码输得慢的用户提示被杀、删除从未执行且无人知晓。

### 内部

- 删除无消费者的 `StopResult.warning` 字段与探测 curl 恒不可达的 `--connect-timeout` 参数；CLAUDE.md 修正版本查询优先级描述（代理可用直接经代理）并补登 `system-proxy.ts` 模块行。

### 修复（第二轮复审）

- 覆写里出现 `__proto__` 键（无论嵌套层还是 `~key` 元素补丁）改为可读报错：此前它会静默把合并结果的原型换掉，写配置时抛带堆栈的裸异常、按程序 bug 渲染，用户无从定位源头。
- `sub remove` 删原始配置文件挪到设置写盘成功之后（仍在同一锁内）：此前先删文件后写设置，磁盘满/权限失败时留下「条目还在、文件已没」的不一致。
- 原子写补 fsync（临时文件 + rename 后父目录）：OS 崩溃/掉电时 settings.json 截断为空的窗口收窄到 fsync 返回之后（macOS 上普通 fsync 只刷页缓存，严格落盘需 F_FULLFSYNC，为已知边界）；崩溃遗留的 `*.tmp` 临时文件由每次命令执行时按龄清扫（数据根目录、订阅与运行时目录三处）。
- `doctor` 的内核版本查询超时改为真正中止子进程（AbortSignal 透传 gh/curl/直连三路）：此前只弃掉等待，报告打完后进程还要等满子进程自身超时（最长约两分钟）才退出，CI 里体检结论已打印却拿不到退出码。
- 覆写 `match` 的 `url-domain` 值含 `*`/`?` 时报错：它只做字面后缀比对，通配恒不命中，此前文件静默对任何订阅都不生效且零提示。
- `mihomo kernel` 在 settings.ports 损坏时降级走 gh/直连（与 doctor/status 同姿态），不再在做任何下载前就中止。
- `start tun` 的日志轮转挪到内核/配置存在性校验之后：秒失败错误不再先把日志 rename 成归档、留下运行中内核往归档文件写的错位。
- 逐 pid 清理内核进程在发信号前复核命令行（`isMihomoProcess`）：pid 被复用时不再可能误杀无关进程，与批量 pkill 分支的安全性对齐。
- `logs 0 -f -o` 报互斥错误：`-o` 打开系统查看器后 `-f` 无处生效，静默忽略会让用户以为在跟随刷新。
- `sub add <url> ""` 报「订阅名不能为空」：不再静默把空串命名成 default（与其他命令对空串位置参数的处理对齐）。
- settings.json 在并发 `reset` 间隙被删除时不再误报「格式损坏」。

### 内部（第二轮）

- `YAML_MAX_ALIASES` 收成共享常量（config/overwrite 两处解析共用）；`needsAutoUpdate` 与 `isSubscriptionStale` 对异常时间戳**刻意相反**的口径加用例锁死，防止重构合并去重时悄悄统一。

## [26.9.90] - 2026-09-29

版本号序号修正，无代码变化：26.9.37 的序号误取了当月发布计数，自本版起序号为**全局历史发布计数**（本版是第 90 个发布）。年.月 仍取发布当日日历，序号永不重置。26.9.37 已标记 deprecated，装到该版本执行 `mihomo update` 会直接升到本版。

---

更早的发布记录（1.x–4.x，含误序的 26.9.37）已归档至 [docs/changelog/CHANGELOG-archive.md](docs/changelog/CHANGELOG-archive.md)，内容原样保留。
