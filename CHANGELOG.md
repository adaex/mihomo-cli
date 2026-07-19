# Changelog

## [3.2.0] - 2026-07-19

### 修复

- **测速隔离实例被主进程管理误杀/误判** - `getMihomoPids`（原 `getAllMihomoPids`）此前用 `pgrep -f <内核路径>` 匹配，会连带命中 `sub test`/`sub clean` 启动的、跑同一内核但 `-f` 指向 `test/runtime/config.yaml` 的隔离实例。导致主实例运行时另开终端测速，`stop`/`start` 会误杀测速实例、或把它误判为残留而拒绝启动。改用「内核路径 + 主 configFile」双段正则精确匹配主实例（三种启动方式命令行均含这两段），隔离实例与仅用编辑器打开配置的进程都不再命中
- **未捕获异常时测速实例泄漏** - `uncaughtException` / `unhandledRejection` / `main().catch` 退出前未执行清理，测速期间崩溃会残留端口 27890 的实例。现三处退出前均调用 `runCleanup()`（此前仅 SIGINT/SIGTERM 有）
- **TUN 启动脚本路径未安全转义** - 生成的 sudo bash 脚本用双引号直接拼接内核/配置路径，`MIHOMO_CLI_DIR` 含 `"`/`$`/反引号时存在本地注入面。改用单引号字面量转义（`shellQuote`，与 daemon 脚本同一范式）
- **带 `no-resolve` 的规则在启动时被误删** - `validateConfig` 校验规则时取逗号分隔的末段当目标，`IP-CIDR,1.1.1.1/32,DIRECT,no-resolve` 这类带 `no-resolve` 修饰后缀的规则，其末段是修饰词而非目标，会被当作"引用不存在目标"静默移除（机场订阅中很常见）。现提取 `getRuleTarget()`：末段为 `no-resolve` 时取倒数第二段；`clean` 的规则清理同步改用
- **`clean` 误删带 `include-all`/`use` 的分组** - `cleanDeadProxies` 只按 `proxies` 清空判定删组，未像 `validateConfig` 那样检查其他节点来源；`{include-all: true, proxies: []}` 这类分组（或引用节点恰好全死但有 `include-all` 兜底）会被从订阅文件里持久删除。补上一致的 `hasOtherSource` 检查
- **Mixed 模式未清理订阅残留的 `tun` 字段** - 订阅/覆写自带 `tun.enable: true` 时，`start`（Mixed）会以 TUN 静默启动，保活（限定 Mixed）也可能带 tun 配置被 launchd 拉起。现 Mixed 模式显式丢弃订阅侧的 tun 字段（TUN 模式仍由系统 `TUN_CONFIG` 强制覆盖）
- **`sub add` 同名订阅被静默覆盖** - 两次不带名称的 `sub add` 会让第二个直接替换 `default`，原订阅 URL 无提示丢失。现同名即报错，提示换名或先删除
- **内核下载可能选中 compatible 版**（Intel Mac）- `-compatible` 变体同样满足"版本号尾缀"判定且字母序靠前，会被优先当作标准版下载（性能低于标准版）。现显式排除，仅在无标准版时回退
- **订阅名路径穿越**（低危）- 原始配置路径直接拼接订阅名，手改 `settings.json` 塞入 `../` 可让读/写/删越出 subscriptions 目录。现统一校验名称合法性；`sub remove` 对非法名跳过文件清理、仍可正常从列表移除

### 变更

- **新增 `runtime.ts` 运行时门面** - 收敛「普通进程（pidFile） vs 保活（launchd 托管）」双轨差异：运行模式判定、运行状态/PID、启停重启统一为三个函数。命令层（`start`/`status`/`sub use`/`ow`/`clean`）不再各自 `if (isDaemonEnabled())` 分支，消除重复与不一致（此前 `clean` 两分支输出已分叉）
- **命令路由改为注册表驱动** - 新增 `commands/registry.ts`，以数据表描述命令的名称/别名/handler/argv 改写；`index.ts` 从表分发（消除 ~110 行手写 switch，模块加载时校验别名无冲突）。帮助文本的命令清单由各命令的 `usage` 生成（单一真相源），修复此前手写 `help` 与实际命令脱节的问题，并补上「快捷命令」映射说明
- **保活模式日志不再无限增长** - daemon 常驻时不经 `process.start`，日志轮转/归档清理从不触发。现 `restartDaemon` 检测日志超 10MB 时跳过热重载、改走 sudo kickstart 路径顺便 copy-truncate 轮转（daemon 日志为 root 属主，用户态无法 truncate；运行中 rename 会让 launchd 的日志 fd 继续写进归档文件，只能 copy-truncate），并顺带清理 7 天前归档
- **`sub update` 后提示重启生效** - 运行中的实例仍使用旧配置，更新完成后提示执行 `mihomo start`
- **`kernel` 命令输出精简** - 不再每次打印整段镜像用法；仅直连失败时才提示 `--mirror`/`--mirror-all` 与可用镜像列表

### 内部

- 提取共用工具消除重复：`escapeRegExp`、`shellQuote`（utils）、`dumpYaml`（config，合并 4 处相同 YAML 序列化选项）
- `external-controller` 地址统一为常量 `CONTROLLER_ADDR`（constants），供配置生成、测速探测、热重载共用；删除 daemon 中因地址恒定而永不触发的运行时端口解析
- `HttpClient.get<T>()` 泛型化，json 模式直接返回目标类型，去掉调用点的 `as unknown as` 强转
- 覆写文件名判定提取为 `isOverwriteFilename`（overwrite），reset 复用
- 归档日志时间戳从 UTC 改为本地时间（与 `logs` 列表展示的 mtime 时区一致），提取 `formatLocalTimestamp`（utils）
- 常量收敛：`CONTROLLER_BASE_URL` 入 constants（daemon 热重载与测速探测共用，删除重复的地址构造）；`DAEMON_BOOT_WAIT_MS` 合并两处重复的 launchd 等待定义；`cleanupOldLogs` 导出供 daemon 复用
- 文档同步：CLAUDE.md 架构表补上 `lifecycle.ts`；`allow-lan` 强制 false 标注为有意安全默认（防覆写误开入站代理）；README 安全章节说明 controller 仅监听回环、无鉴权的适用边界

---

## [3.1.0] - 2026-07-19

### 修复

- **保活模式下经局域网跳板的代理连不通**（v3.0.0 引入的严重 bug）- 用户级 LaunchAgent 启动的内核受 macOS 15+ 本地网络隐私（TCC）限制，访问**局域网其他设备**被静默拦截（报 `no route to host`），导致经局域网 socks5 跳板转发的内网流量在 `daemon on` 后全部失效、`daemon off` 后立刻恢复。手动在系统设置授权对裸命令行二进制无效。改为 **root 级 LaunchDaemon** 彻底解决（系统上下文不受该限制）

### 变更

- **保活迁移到系统级 LaunchDaemon** - plist 位于 `/Library/LaunchDaemons/`（`root:wheel`），以 root 运行；`daemon on` / `daemon off` 需输入一次管理员密码（复用 TUN 模式的交互式 sudo 范式，一次密码完成全部操作）
- **配置变更优先热重载（免密）** - `sub use` / `ow on|off` / `clean` 等触发的重启优先经 external-controller `PUT /configs` 热重载（走 localhost、无需 sudo），失败才回退到需密码的 `launchctl kickstart`
- **`daemon status` / `status` 免密** - 保活状态查询改用 `pgrep` + root 属主过滤判定运行状态，不再调用需 sudo 的 `launchctl print`
- **关闭保活时归还文件属主** - `daemon off` 会把 root 守护进程创建的日志、数据文件 `chown` 回当前用户，避免后续非保活模式 `start` 因 root 属主日志无法写入而失败
- `daemon on/off` 在非交互终端（无 TTY，如 CI）会明确报错而非挂起

---

## [3.0.0] - 2026-07-19

### 新增

- **进程保活（`daemon`）** - 基于 macOS 原生 launchd（LaunchAgent），让 mihomo 内核在崩溃、被系统 kill、开机/重新登录后自动拉起，代理后台常驻
  - `mihomo daemon on` - 开启保活（生成 LaunchAgent、`KeepAlive` 崩溃重启 + `RunAtLoad` 开机自启，仅 Mixed 模式，装载无需 sudo）
  - `mihomo daemon off` - 关闭保活并停止代理
  - `mihomo daemon status` - 查看保活状态
  - 零额外常驻进程、零轮询：保活由系统 launchd 兜底，不占用系统资源

### 变更

- **保活开启时的生命周期联动** - 启用保活后，`start` / `clean` / `ow on|off` / `sub use` 的重启改走 `launchctl kickstart`（不再裸 `kill`，避免与 `KeepAlive` 打架）；`stop` 会提示改用 `daemon off`；`start tun` 会提示保活仅支持 Mixed，需先 `daemon off`
- **`status` 显示保活状态** - 保活开启时，运行状态以 launchd 托管进程为准（托管进程不写 pidFile）
- **`reset` 支持 `daemon` 目标** - `reset daemon` / `reset --full` 会先卸载 launchd 任务再删除 plist；例行 `reset`（无参）默认保留保活

---

## [2.10.0] - 2026-07-18

### 依赖升级

- **js-yaml 4 → 5**（破坏性大版本）：迁移到命名空间导入，`noCompatMode` 选项移除后改用 `CORE_SCHEMA`（YAML 1.2 语义），保持 `yes/no/on/off` 等值不被错误加引号，与 mihomo 内核解析一致；移除随之内置类型的 `@types/js-yaml`
- **TypeScript 6 → 7**（原生编译器）：类型检查更快，构建仍走 tsup/esbuild
- **lint-staged 16 → 17**：随之将 `engines.node` 门槛从 `>=22.0.0` 抬高到 `>=22.22.1`
- 其他：Biome 2.4 → 2.5、tsx 4.21 → 4.23、@types/node 22.19 → 22.20

### 修复

- **`mihomo tun` 丢弃命令行参数** - `mihomo tun -s`、`mihomo tun -u 30000 -t 3000` 等此前被静默忽略（快捷命令未透传参数），现与 `mihomo start tun ...` 行为一致

### 优化

- **默认值常量收归 `constants.ts`** - 测速超时/并发（2000/100）、清理轮次、自动更新超时、自动清理阈值、更新间隔等默认值统一集中管理，消除散落的裸魔数
- **消除重复逻辑** - 订阅下载的缓存元信息组装（`downloadSubscription` / `downloadMergedSubscription`）、进程停止失败处理（start/stop/clean 三处）、更新结果打印、单订阅下载分派统一抽取复用
- **清理冗余导出** - 移除仅在本模块内使用的多余 `export`
- **文档一致性** - README 镜像列表与代码对齐；`dir open` 帮助补列 `data` 目标

---

## [2.9.2] - 2026-07-18

### 修复

- **带值选项被误当参数** - `sub test -t <ms>`、`sub clean -r <轮数>`、`logs -n <行数>` 等命令在不显式指定名称时，选项的值（如 `3000`）会被误认为订阅名/日志编号导致报错。现已正确识别，这些选项可独立使用

### 安全 / 健壮性

- **内核下载后自检** - 下载解压内核后立即运行 `mihomo -v` 校验二进制可执行且未损坏（架构不匹配、下载截断等），失败则删除并报错（mihomo 上游未提供 checksums，故以自检替代哈希校验）
- **镜像下载来源提示** - 使用 `--mirror` 经第三方中转下载内核时，提示无法验证来源完整性
- **自动更新超时竞态** - 自动更新订阅超时后，真正中断底层网络请求（此前请求仍会在后台跑完并写盘，与「已用缓存启动」的主流程存在竞态）
- **清理失败节点同步清理规则** - `clean` 删除空代理组后，同步移除订阅配置中引用这些已删组的规则，避免残留

### 其他

- 清理未使用代码，简化进程信息采集

---

## [2.9.1] - 2026-06-28

### 修复

- **测试实例进程泄漏** - `sub test` / `sub clean` 期间按 Ctrl+C 不再残留测试内核进程（端口 27890）。新增统一的退出清理机制（`lifecycle.ts`），信号退出前同步清理
- **`clean` 模式降级** - `mihomo clean` 清理后重启时保留当前运行模式，TUN 用户不再被静默切回 Mixed
- **`sub web` 打开错误订阅** - 无参数时打开当前激活订阅，而非第一个添加的订阅
- **订阅更新间隔校验** - 机场返回非正数的 `profile-update-interval`（如 -1）时回退默认间隔，不再每次启动都重新下载
- **内核版本探测超时** - `getKernelVersion` 增加 5 秒超时，损坏的内核二进制不再导致命令永久卡死

### 安全 / 健壮性

- **去除 shell 命令拼接** - 进程管理、内核解压等处的 `execSync` 字符串拼接全部改用 `spawnSync` 参数数组，消除路径注入风险
- **进程匹配精确化** - `pgrep` / `pkill -f` 的路径模式做正则转义，避免路径中的 `.` 被当作通配符误匹配/误杀其他进程
- **原子文件写入** - settings、订阅缓存、运行时配置改为「写临时文件 → 重命名」，避免写入中途崩溃导致文件损坏
- **settings 损坏备份** - `settings.json` 解析失败时自动备份为 `.bak`，避免被默认值覆盖丢失
- **其他** - `formatBytes` 处理 `Infinity`；`isProxyValid` 兼容 SS2022 base64url 密钥；`ui` / `dir open` 防原型链属性；内核归档目录递归加深度限制

---

## [2.9.0] - 2026-05-13

### 新功能

- **跳过自动更新** - `start -s` 跳过启动时的订阅自动更新
- **自动更新超时** - `start -u <ms>` 设置自动更新超时时间（默认 10 秒），超时后使用缓存配置继续启动
- **通用 Promise 超时工具** - 新增 `withTimeout` / `TimeoutError` 工具函数

### 变更

- **命令别名调整** - 移除 `mmc`，新增 `mhm` 作为命令别名

---

## [2.8.1] - 2026-05-07

### 修复

- **stop/down 不再误触 sudo** - 非 TUN 模式启动的进程停止时不再提示输入 root 密码

---

## [2.8.0] - 2026-05-05

### 新功能

- **start/up 支持测速参数** - `-r N` 清理轮次、`-t ms` 超时、`-j N` 并发数
- **GitHub 订阅差异化策略** - 自动清理阈值 GitHub 50 / 其他 100；默认更新间隔 GitHub 6h / 其他 12h

### 改进

- **默认测速轮次** - 从 3 轮调整为 2 轮
- **统一超时默认值** - 所有测速命令默认超时统一为 2000ms

---

## [2.7.3] - 2026-05-04

### 改进

- **代码清理** - 提取 `DEFAULT_CLEAN_ROUNDS` 常量，消除重复魔数；简化进度条内部状态

---

## [2.7.2] - 2026-05-04

### 修复

- **进度条轮次标题** - 多轮测试时第 1 轮标题正确显示在进度条之前，单轮不显示轮次标题

### 改进

- **自定义轮数** - clean 命令支持 `-r N` / `--rounds N` 指定测试轮数（默认 3）

---

## [2.7.1] - 2026-05-04

### 修复

- **进度条计数器修复** - 清理/测试多轮重试时，✓/✗ 计数不再跨轮累加，每轮独立计数
- **轮次标题位置修复** - 移除错位的"第 1 轮测试"标题，重试轮标题正确显示在对应进度条之前

---

## [2.7.0] - 2026-05-03

### 移除

- **bench 命令** - 移除免费订阅源基准测试功能
- **sub free 子命令** - 移除内置免费订阅源快速添加功能

---

## [2.6.3] - 2026-05-03

### 改进

- **自动清理三轮重试** - 节点测试失败后自动重试两轮，三轮都失败才删除，减少网络抖动导致的误删
- **实时进度条** - 测试/清理过程中显示单行刷新进度条，测完输出按名称排序的最终结果
- **并发模型优化** - 节点测试从分批等待改为 worker pool，逐个完成即时反馈
- 重试通过的节点标注轮次（第N轮通过）
- start/test/clean 命令统一使用进度条

---

## [2.6.2] - 2026-05-03

### 改进

- **配置校验增强** - 新增重名节点/分组去重、无效规则清理，覆盖更多启动失败场景
- 移除多余的 `mihomo -t` 预校验（启动本身即校验）

---

## [2.6.1] - 2026-05-03

### 修复

- **启动前配置校验** - 自动检测并修复 proxy-group 中引用不存在的节点/分组，避免内核启动失败

### 改进

- 移除已废弃的 `global-client-fingerprint` 配置项，消除内核启动时的 warning

---

## [2.6.0] - 2026-05-03

### 改进

- **统一使用 mixed-port**：用 `mixed-port: 7890` 替代原来的 `port: 7890` + `socks-port: 7891`，单端口同时支持 HTTP 和 SOCKS5
- **BASE_CONFIG 优化**：新增 `unified-delay`、`tcp-concurrent`、`geo-auto-update`、`profile.store-selected`，不再依赖订阅自带这些配置
- **自动启用 sniffer**：检测到 `fake-ip` 模式时自动注入 sniffer 配置（嗅探 HTTP/TLS/QUIC），确保域名规则正常工作；订阅自带 sniffer 时不覆盖

---

## [2.5.0] - 2026-05-03

### 新功能

- **test 命令** - `mihomo test` 快速测试当前运行实例的节点连通性
- **clean 命令** - `mihomo clean` 清理失败节点并自动重启

### 改进

- `sub test` / `sub clean` 改用独立临时进程测试，不影响当前代理，支持测试任意订阅（不限于活跃订阅）
- 启动时 auto-clean 使用当前运行实例直接测速，提升启动速度

### 移除

- 移除 `sub best` 命令

---

## [2.4.2] - 2026-05-02

### 改进

- 自动清理阈值统一为 50 个节点（不再区分订阅类型）
- 订阅默认更新间隔从 12 小时缩短为 4 小时

---

## [2.4.1] - 2026-05-02

### 修复

- 启动时清除代理环境变量（`http_proxy` / `https_proxy` / `all_proxy`），避免系统已有代理导致请求异常

---

## [2.4.0] - 2026-05-02

### 新功能

- **sub best** - `sub best <id>` 一键添加聚合订阅（每小时自动更新、去重、测活）
  - `best 1` 精选 29 组（仅测速源：FreeSubsCheck, shaoyouvip, dalazhi, getnode）
  - `best 2` ACL4SSR 29 组（全部 7 个源）
  - `best 3` freeSub 24 组
- **新增免费源** - yahr601, Auto-Sync, ssrsub, dalazhi, getnode

### 修复

- `setDefaultSubscription` 移到下载成功后再设置，避免下载失败留下无效默认订阅

---

## [2.3.1] - 2026-05-02

### 新功能

- **合并订阅** - `sub add url1,url2 name` 支持逗号分隔多 URL，合并节点（按名去重），分组/规则取第一个源
- **sub free 0** - 特殊 ID `0` 自动合并免费源 #1 + #2（节点更多，配置相同）

### 改进

- 合并订阅在列表中显示 `[合并 N 源]` 标记
- `sub update` 自动识别合并订阅并重新下载合并
- URL 脱敏支持逗号分隔多 URL

---

## [2.3.0] - 2026-05-02

### 新功能

- **bench 命令** - 内置 20 个免费订阅源基准测试，下载→启动独立实例→测速→排名。支持 `-t` 超时、`-j` 并发、按名过滤
- **sub free 命令** - `sub free <id>` 快速添加内置免费订阅（命名 free1/free2/...），自动切换并支持 `sub web` 跳转 GitHub 页面
- **启动自动清理** - free* 订阅超 50 节点、其他超 100 节点时启动后自动测速清理
- **overwrite 代理排除** - 通过 `+proxies` 注入的代理自动从 `include-all: true` 分组中排除

### 改进

- **启动失败详情** - 启动失败时显示完整 mihomo 日志（不再截断），便于定位 GeoSite/规则等配置错误
- **CJK 表格对齐** - bench 排名表使用 `displayWidth` 处理中文字符宽度

---

## [2.2.4] - 2026-05-01

### 修复

- **reset 命令误触 sudo**：修复 `reset` 停止进程时强制使用 sudo 的问题，改为自动检测是否需要提权

### 改进

- **重命名 `shortenProxyNames` → `normalizeProxyNamesBeforeSave`**：明确该函数是写入前的预处理步骤，避免误用

---

## [2.2.3] - 2026-05-01

### 修复

- **非 TUN 模式误触 sudo**：修复 `start` 命令在 mixed 模式下停止旧进程时强制使用 sudo 的问题，改为自动检测是否存在 root 进程再决定是否提权

---

## [2.2.2] - 2026-05-01

### 修复

- **文件描述符泄漏**：修复 `startMixedMode` 中 spawn 后未关闭 fd 的问题
- **forceSudo 参数失效**：修复 `cleanupAll` 忽略调用方传入的强制 sudo 参数
- **formatBytes 溢出**：修复超大字节值（>1PB）导致显示 `undefined` 单位
- **YAML 解析类型检查**：`parseYamlOrJson` 现在拒绝非对象类型的 YAML 内容
- **spawn 错误处理**：`openUrl` 添加 error 事件处理，防止未捕获异常
- **UserInfo 类型转换**：移除 `parseUserInfo` 中多余的 `as unknown` 双重转换

### 安全

- **订阅名称校验**：新增文件名安全校验，防止路径穿越等不安全名称

---

## [2.2.1] - 2026-05-01

### 修复

- **节点名称精简时序**：修复 `shortenProxyNames` 在测速前执行导致 API 返回 "Resource not found" 的问题，改为测速完成后再精简
- **清理安全阈值**：存活节点不足 1% 时跳过清理，提示用户检查原始订阅

---

## [2.2.0] - 2026-05-01

### 新增

- **节点测速**：`sub test [name]` 测试订阅节点连通性，支持 `-t` 超时和 `-j` 并发参数
- **节点清理**：`sub clean [name]` 测速后自动清理不可用节点，移除空分组
- **启动自动清理**：`start` / `start tun` 启动时，节点数超过 100 自动执行清理

### 安全

- **强制端口配置**：HTTP 端口固定 7890，SOCKS5 端口固定 7891，忽略订阅中的 `mixed-port` 配置

---

## [2.1.0] - 2026-05-01

### 新增

- **删除订阅**：`sub remove <name>` 删除订阅（别名 `rm`/`delete`），同时清理缓存和配置文件
  - 删除当前使用中的订阅时自动切换到第一个剩余订阅
- **添加即切换**：`sub add` 添加订阅后自动切换为当前使用的订阅

### 安全

- **强制 `allow-lan: false`**：无论订阅配置如何，始终禁止局域网访问
- **强制 `external-controller: 127.0.0.1:9090`**：控制面板仅监听本地，防止不可信订阅暴露控制接口
- **剥离 `external-ui` 相关字段**：构建配置时强制删除 `external-ui`/`external-ui-name`/`external-ui-url`，防止订阅触发额外下载

### 优化

- **TUN DNS 劫持**：`dns-hijack` 从 `['0.0.0.0:53']` 改为 `['any:53', 'tcp://any:53']`，同时劫持 UDP 和 TCP DNS，覆盖 IPv4/IPv6
- **帮助顺序统一**：订阅子命令统一为 use → add → update → remove → web 顺序
- **`removeSubscription` 返回切换信息**：返回自动切换到的订阅名，避免调用方重复读取状态
- **`setDefaultSubscription` 跳过冗余写入**：已是同值时直接返回
- **删除后跳过自动更新**：`sub remove` 后列出订阅时不触发网络更新

---

## [2.0.1] - 2026-04-22

### 修复

- **TUN DNS 默认值**：使用属性存在性检查替代 falsy 检查，避免订阅中 `dns.enable: false` 等值被覆盖
- **覆写文件名显示**：`overwrite.yaml` 不再显示为 "yaml"，改为 "主文件"

### 优化

- **消除重复文件扫描**：覆写文件加载从每次构建 2 次减少为 1 次
- **清理死代码**：移除 `resetUserData`、`getGitHubMirror`、`setGitHubMirror`、未使用的类型字段

---

## [2.0.0] - 2026-04-11

### 架构重写

完整重写为 TypeScript，保持所有功能不变。

- **语言**：JavaScript (CJS) → TypeScript (ESM)
- **构建**：tsup 单文件打包 (esbuild)，产物 ~170KB
- **运行时**：Node.js >= 22
- **工具链**：eslint + prettier → Biome；axios → 原生 fetch
- **类型系统**：`src/types.ts` 集中管理所有类型定义
- **模块拆分**：`config.js` (517 行) → `paths.ts` + `settings.ts` + `config.ts`
- **命令处理器**：从 `index.js` (1177 行) 拆分为 `src/commands/` 下 12 个独立文件

### 变更

- **命令别名**：`mmc` → `mhm`（避免误解）
- **依赖精简**：移除 axios，运行时仅依赖 js-yaml + compare-versions（已打包进单文件）
- **开发依赖**：TypeScript 6、tsup 8.5、tsx 4.21、Biome 2.4

## [1.5.1] - 2026-04-11

### 修复

- 修复内核下载时引用不存在的目录键 `DIRS.core`，导致下载失败 (`kernel`)
- 修复订阅页面打开时调用不存在的函数 `readSubscriptionsCache`，导致报错 (`sub web`)

## [1.5.0] - 2026-04-10

### 新增功能

- **快捷命令**：新增顶层命令快捷方式，减少输入
  - `mihomo up` = `mihomo start`
  - `mihomo down` = `mihomo stop`
  - `mihomo tun` = `mihomo start tun`
  - `mihomo use <name>` = `mihomo sub use <name>`
  - `mihomo on` / `mihomo off` = `mihomo ow on` / `mihomo ow off`
  - `mihomo open <target>` = `mihomo dir open <target>`
- **订阅选择机制**：使用 `active_subscription` 字段标识当前订阅，不再依赖数组顺序
- **配置构建调试**：运行时目录生成 3 阶段中间文件，方便排查配置问题
  - `1.subscription.yaml` — 订阅原始配置
  - `2.overwrite.yaml` — 覆写合并内容
  - `3.system.yaml` — 系统补充值（BASE_CONFIG + TUN）

### 重构

- **目录结构调整**：
  - `core/` → `kernel/`（内核目录）
  - `.runtime/` → `runtime/`（运行时目录）
  - `overwrites/` 目录 → 根目录 `overwrite.yaml` + `overwrite.*.yaml`（覆写文件扁平化）
- **配置合并逻辑**：BASE_CONFIG / TUN_CONFIG 改为只补充订阅中缺失的字段，不再强制覆盖已有值
- **TUN 模式**：移除 `ipv6: false` 硬编码，交由订阅或覆写控制
- **`dir open` 目标精简**：移除 `overwrites` 和 `settings`，保留 `root|subs|logs|data|runtime|kernel`

### 优化

- **文案调整**：
  - "默认订阅" → "当前订阅" / "使用中"
  - 覆写文件名显示去除 `overwrite.` 前缀
  - 覆写配置 "目录" → "位置"
- **dir 信息**：新增显示内核目录路径

---

## [1.4.1] - 2026-04-08

### 优化

- **状态显示文案**：
  - `○ 已停止` → `不在运行`（移除符号，更简洁明确）
  - `未在运行` → `不在运行`（统一措辞）
- **代码风格统一**：标签输出格式统一为 `colors.gray('标签: ')`

---

## [1.4.0] - 2026-04-07

### 新增功能

- **reset 命令增强**：
  - 支持按目标名称模糊删除：`mihomo reset subs logs` 删除订阅和日志
  - 可用目标：`subs`, `logs`, `kernel`, `overwrites`, `settings`, `data`, `runtime`
  - `--full` 删除全部
  - 留空默认保留：设置、内核、覆写配置
- **kernel 镜像改进**：
  - 默认改为**直连**下载（不再强制使用镜像）
  - `--mirror` 不带参数时使用默认镜像 `v6.gh-proxy.org`
  - `--mirror hk.gh-proxy.org` 指定镜像
  - `--mirror-all` API 请求和下载都使用镜像（解决 API 访问受限问题）
  - 命令中列出所有可用镜像

### 修复

- **reset 覆写目录**：补充删除 `overwrites` 目录
- **reset 保留逻辑**：修复覆写配置的保留/删除逻辑

### 优化

- **状态显示**：运行中/已停止添加图标区分
  - `● 运行中` (绿色)
  - `○ 已停止` (黄色)
- **措辞明确**：动作成功的"已停止"改为"已停止进程"，避免与状态显示混淆
- **代码重构**：
  - 常量提取：`BATCH_KILL_THRESHOLD` 等
  - 镜像处理逻辑优化，新增 `normalizeMirrorUrl()` 统一处理

---

## [1.3.1] - 2026-04-07

### 优化

- **短帮助命令顺序**：调整常用命令展示顺序，`ui` 放最后，`ow` 提前到第三位

---

## [1.3.0] - 2026-04-07

### 架构重构

- **代码组织优化**：将 `index.js` 中的业务函数迁移到对应模块，职责更清晰
  - `getActiveSubscription`, `findSubscriptionFuzzy`, `pickSingleSubscription` → `subscription.js`
  - `parseMirrorArg`, `normalizeMirrorUrl` → `utils.js`
  - `openLogFile`, `viewLogWithTail` → `process.js`
  - `DIRECTORY_TARGETS` → `config.js`

### 代码质量

- **统一 HTTP 客户端**：在 `utils.js` 中添加 `createHttpClient()` 函数，统一 `User-Agent` 为 `mihomo-cli/${VERSION}`
- **常量提取**：将硬编码的超时、等待时间等提取为命名常量
  - `PROCESS_WAIT_ATTEMPTS`, `PROCESS_WAIT_INTERVAL`
  - `STARTUP_WAIT_MS`, `SUDO_TIMEOUT_MS`, `TUN_MODE_POST_WAIT_MS`
  - `DEFAULT_LOG_RETENTION_DAYS`
  - `KERNEL_HTTP_TIMEOUT`, `KERNEL_MAX_CONTENT_LENGTH`, `KERNEL_DOWNLOAD_TIMEOUT`

### 开发工具链

- **ESLint**：配置 ESLint v10 + `@eslint/js` + `globals`，自动检测未使用变量/导入
- **Husky**：配置 Git hooks
- **lint-staged**：提交前自动运行 `eslint --fix` + `prettier --write`
- **Import 风格统一**：所有文件统一使用「内置模块 → 第三方模块 → 本地模块」的分组顺序和空行

### 清理

- 移除未使用的变量导入
- 未使用的 catch 错误变量统一使用 `_e` 前缀

---

## [1.2.5] - 2026-04-07

### 新增功能

- **update 命令**：新增 `mihomo update` 命令，执行 `npm install -g mihomo-cli` 快速更新 CLI 版本
  - 支持别名：`update`、`upd`、`upgrade`

---

## [1.2.4] - 2026-04-07

### 修复

- **路径安全**：`getLogPathByName()` 增加 `isPathUnderDir()` 校验，防止潜在的路径遍历风险
- **错误提示**：覆写配置文件解析失败时显示警告日志，不再静默忽略

### 重构

- **代码结构**：工具函数（`sleepSync`、`formatBytes`、`isProcessRunning` 等）提取到 `utils.js` 模块，简化各模块依赖
- **命名规范**：统一函数命名为全称单数
  - `autoUpdateStaleSubscriptions` → `autoUpdateStaleSubscription`
  - `applyOverwrites` → `applyOverwrite`
  - `loadOverwriteFiles` → `loadOverwriteFile`
  - `listOverwriteFiles` → `listOverwriteFile`

---

## [1.2.3] - 2026-04-07

### 优化

- **简短帮助**：大幅精简，只列出最常用命令，增加 `mihomo help` 提示
- **性能**：
  - settings 读取增加内存缓存，减少重复 JSON 解析
  - 内核版本增加缓存，避免重复执行 `mihomo -v`
  - `sleepSync()` 改用 `Atomics.wait` 而非 `execSync('sleep')`，减少子进程开销

### 重构

- 精简模块导出接口，移除不必要的内部函数导出
- 新增 `formatProxySummary()` 复用函数（消除 3 处重复代码）
- `pickSingleSubscription()` 移除多余参数
- 统一代码风格：数组/条件表达式换行风格、`cmdUi` → `cmdUI` 命名一致性

### 文档

- README 修复：GitHub 链接、重复段落、`profile-update-interval` 格式

---

## [1.2.2] - 2026-04-05

### 优化

- **简短帮助**：`subscription` 简化为一行
- **详细帮助**：补充完整的子命令列表（`list`、`directory open` 等）

### 修复

- 回滚 v1.2.1 中对详细帮助的错误修改（详细帮助保持多行格式）

---

## [1.2.1] - 2026-04-05

### 文档

- README 添加覆写配置和自动重启说明
- CLAUDE.md 精简和完善，增加发布检查清单

### 文档

- README 添加覆写配置和自动重启说明
- CLAUDE.md 精简和完善，增加发布检查清单

---

## [1.2.0] - 2026-04-05

### 新增功能

#### 配置变更自动重启

- **sub use 自动重启**：切换默认订阅后，如果 mihomo 正在运行则自动重启
- **ow on/off 自动重启**：启用/禁用覆写配置后，如果 mihomo 正在运行则自动重启
- **状态检查**：操作前检查是否已是目标状态，避免重复操作

### 重构

#### 命名规范统一

- **函数重命名**：统一使用全称单数
  - `findSubsFuzzy` → `findSubscriptionFuzzy`
  - `pickSingleSub` → `pickSingleSubscription`
  - `printSubList` → `printSubscriptionList`
  - `cmdSub` → `cmdSubscription`
  - `cmdDirs` → `cmdDirectory`
  - `DIR_TARGETS` → `DIRECTORY_TARGETS`
- **帮助文档统一**：
  - 示例统一使用 `mihomo` 而非 `mihomo-cli`
  - 命令列表使用全称单数 `directory` 而非 `directories`
  - 提示语中的命令示例添加 `mihomo` 前缀

### 修复

- 修复缺失的 `path` 模块导入
- 统一引号风格（命令示例使用双引号）

## [1.1.0] - 2026-04-05

### 新增功能

#### 覆写配置

- **覆写配置功能**：支持在订阅配置基础上进行自定义覆写
  - `ow` / `overwrite` 命令：
    - `ow` / `ow list`：查看覆写配置状态和文件列表
    - `ow on` / `ow off`：启用/禁用覆写配置
  - **覆写文件位置**：`~/.mihomo-cli/overwrites/` 目录
  - **支持的合并策略**：
    - `key!`：强制覆盖整个对象
    - `+key`：数组前置插入
    - `key+`：数组追加
    - `<+key>`：处理特殊键名
  - **执行顺序**：按文件名顺序加载，后面的文件覆盖前面的配置

### 优化

#### 输出格式

- 统一输出格式，移除操作提示开头的 2 空格缩进
- 操作结果和列表之间自动添加空行分隔
- `start` 命令启动后自动显示完整状态信息
- `sub` / `ow` 操作后自动刷新列表显示

#### 文案统一

- 节点显示统一为「组在前，节点在后」的格式：`16 组, 89 节点`
- 统一「部分进程未终止」文案
- 优化状态显示对齐（`PID` 单独多 1 空格对齐）

#### 命令改进

- `ow` 无参数时等同于 `ow list`
- `sub` 无参数时等同于 `sub list`
- 帮助文档中移除 `list` 子命令展示（无参即 list）

## [1.0.3] - 2026-04-05

### 文档修复

- **数据目录路径**：修正 README 中的用户数据存储位置
  - `~/Library/Application Support/mihomo-cli/` → `~/.mihomo-cli/`
  - 修正目录结构：`runtime/` → `.runtime/`，删除不存在的 `config/` 子目录
- **CLI 帮助文档**：修正 `log`、`logs`、`kernel` 命令的语法和描述
  - `logs` 命令明确 `0`=当前日志，`1+`=归档日志
  - 补充 `-o` 选项说明

## [1.0.2] - 2026-04-05

### 修复

- **版本号同步**：`index.js` 不再硬编码版本号，改为从 `package.json` 读取
  - 修复 `1.0.1` 发布后 `--version` 仍显示 `1.0.0-alpha.1` 的问题

## [1.0.1] - 2026-04-05

### 新增功能

#### 订阅管理增强

- **订阅信息解析**：自动解析 `subscription-userinfo` 响应头
  - 显示已用流量 / 总流量 / 到期时间
  - 从 `content-disposition` 提取用户名
  - 保存 `profile-update-interval`、`profile-web-page-url`

- **数据分离存储**：
  - 静态配置（name, url, updatedAt）→ `settings.json`
  - 动态数据（流量、用户名、页面URL）→ `subs-cache.json`

- **自动更新过期订阅**：
  - 默认间隔 12 小时（或订阅服务端指定的 `profile-update-interval`）
  - `start` 命令、`sub list` 命令时自动触发检查
  - 并行更新所有过期订阅，失败时使用本地缓存

- **订阅命令增强**：
  - `sub use <name>`：设置默认订阅（支持模糊匹配）
  - `sub web [name]`：打开订阅页面（无参打开默认）
  - `sub update`：无参时更新所有订阅
  - **模糊匹配**：精确匹配 → 前缀匹配 → 包含匹配，多匹配时提示

#### 日志管理

- **日志轮转**：每次启动前自动归档当前日志
  - 命名格式：`mihomo.YYYY-MM-DD_HH-MM-SS.log`
- **自动清理**：默认保留 7 天日志
- **新命令**：
  - `logs`：列出当前和归档日志（按时间排序）
  - `logs <编号>`：查看指定归档日志
    - `-n N`：指定显示行数（默认 100）
    - `-o`：用系统默认编辑器打开
  - `log -o`：用系统编辑器打开当前日志

#### 内核更新增强

- **镜像参数支持**：
  - `kernel hk.gh-proxy.org`：使用指定镜像
  - `kernel --mirror <url>`：显式指定镜像
  - `kernel --no-mirror` / `--direct`：直连，不使用镜像
- **镜像配置持久化**：
  - `getGitHubMirror()` / `setGitHubMirror()`
  - 默认：`https://v6.gh-proxy.org/`
  - 可用镜像列表在命令中列出
  - 空字符串 `""` 或 `false` 表示禁用镜像

#### 命令别名

新增以下命令别名，任意一个均可调用：

- `mihomo`
- `mmc`
- `mh`

#### 启动流程改进

- `start` 命令现在包含完整的重启/切换逻辑：
  - 先检查并自动更新过期订阅
  - 再完全停止现有进程（即使没进程也清理运行时文件）
  - 最后启动新进程
- **移除** `restart` 命令（`start` 已包含）
- **移除** `clean` 命令（`stop` 已包含清理）

### 改进

- 配置模块 `parseYamlOrJson()`：统一的 YAML/JSON 解析
- 订阅列表 `sub list` 显示：
  - 默认订阅标记 `[默认]`
  - 更新时间 / 更新间隔
  - 用户名（如有）
  - 流量使用：已用 / 总量 + 百分比
  - 到期时间
  - 订阅页面 URL
- `rmrf()` 改用原生 `fs.rmSync(recursive: true, force: true)`
- 启动脚本日志改为追加模式 (`>>`) 而非覆盖

### 移除

- 移除 `geodata` 相关功能：
  - `GEODATA_REPO`、`GEODATA_FILES` 常量
  - `downloadGeodata()` 函数
  - `downloadFile()` 内联函数

## [1.0.0-alpha.1] - 2026-04-05

- 初始版本发布
- 基础功能：启动/停止、订阅管理、内核更新、Web UI
