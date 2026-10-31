# 架构与契约

需要决策理由时按 D 编号或标题搜索 [架构决策](decisions.md)，无需通读全文

## 模块地图

| 模块 | 职责 |
| --- | --- |
| `commands/registry.ts` | 命令、别名、帮助与 argv 改写的唯一登记表 |
| `commands/*.ts` | 命令处理器；shared 提供子命令分发、确认与重启入口 |
| `types.ts` / `constants.ts` / `flags.ts` | 共享类型、默认值与带值选项登记表 |
| `argv.ts` / `format.ts` / `suggest.ts` / `text.ts` | argv 解析、显示格式化、did-you-mean、字符串安全 |
| `kernel-args.ts` | kernel 的 --mirror/--proxy 选项解析与白名单 |
| `settings.ts` | 设置、订阅列表、订阅缓存与原始配置读写 |
| `subscription.ts` | 订阅下载、更新、配置准备与提交 |
| `config.ts` | YAML 解析、覆写与系统配置合并、内核原生校验 |
| `overwrite.ts` | 覆写加载（YAML + JS 脚本）、作用域过滤与合并语法 |
| `runtime.ts` | Mixed 服务与 TUN 临时进程的运行时入口 |
| `service.ts` | 用户级 LaunchAgent 的安装与启停、健康确认 |
| `launchctl.ts` / `stop-epoch.ts` / `hot-reload.ts` | launchctl 解析与状态读取、停止计数与并发基线（D2/D4）、热重载探测与结论；调用方直接从各自模块导入，service.ts 不做转发 |
| `process-probe.ts` / `process-start.ts` / `process-stop.ts` | 进程探测、TUN 启动、清理与残留处置（未走完的清理：进程仍在则抛、已清空则警告） |
| `kernel.ts` / `http.ts` | 内核下载与有超时、大小限制的 HTTP 客户端 |
| `paths.ts` | 路径、目录、原子写与跨进程锁 |
| `log-files.ts` / `open.ts` | 内核日志轮转、查询与系统打开操作；归档原子占名原语供诊断轮转复用 |
| `diagnostic-events.ts` | CLI 操作上下文、白名单事件与配置哈希、同步 JSONL 追加及独立轮转（D16） |
| `redact.ts` | `config` 展示侧的凭据脱敏：敏感键递归掩码、provider 订阅 URL 复用 maskUrl |
| `system-proxy.ts` | env 自代理判定（isLoopbackHost/proxyEnvPointsAtSelf）与系统代理只读检测、分档提示（不写系统设置） |
| `proxy-probe.ts` / `spinner.ts` / `sudo.ts` | 连通性探测、等待反馈、按需提权 |
| `curl-spawn.ts` | 全仓 curl 子进程代理策略唯一出口，产物下载、release API 查询与连通性探测共用（D9） |
| `errors.ts` / `utils.ts` / `colors.ts` / `lifecycle.ts` | 错误、杂项（sleep）、颜色、信号处理 |

## 产品边界

开发判据以此为准，用户承诺见 [README](../README.md)

- Mixed 只由用户级 LaunchAgent 托管；TUN 是按需 sudo 的临时进程，CLI 本身不以 root 运行
- 不自动设置系统代理、不提供 proxy on/off；用户主路径是在具体浏览器或需要代理的应用中按需配置 Mixed 端口，快速开始与启动提示不推荐全局 Mac 代理或 `networksetup`（D15）。`system-proxy.ts` 只读，不能扩展成写系统设置
- 单活跃订阅；多机场节点用 mihomo 原生 proxy-providers；SSH 出口由用户自行 `ssh -D`
- 注册表只登记当前支持的命令与别名；未知命令/子命令/选项统一报错，不维护旧版本迁移分支
- 破坏性操作需要确认：非 TTY 且无显式跳过选项时报错退出 1，交互拒绝才显示已取消；`sub remove` 精确同名视为明确意图直接删除，只有模糊命中需要确认
- reset 流程固定：解析与确认 → 停止或卸载服务 → 清理进程 → 删除目标 → 更新相关设置；确认前不做破坏性操作；删除失败必须报错，成功提示以实际删除为准
- 服务 label 固定 `com.mihomo-cli.daemon`，可用 `MIHOMO_CLI_DAEMON_LABEL` 隔离；label 是持久化注册键，随意改名会遗留无法管理的自启进程

## 关键不变量

跨模块契约的论证见 [架构决策](decisions.md)

### 错误与结果

- 预期错误抛 `CliError` 由 main().catch 统一渲染；再包装前透传已有 CliError；模块顶层不抛 CliError
- 报告成功要有独立结果依据（写入结果/健康/卸载/大小），不能用「命令没报错」代替
- 探测失败 ≠ 目标不存在：launchctl print 只认 113 为未装载，bootout 容忍 3/113（`BOOTOUT_NOT_LOADED_CODES` / `isBootoutNotLoaded` 唯一出处），pgrep/pkill 只收退出码 0/1

### 数据与并发

- `readSettings()` 每次读盘；一致视图由调用方在命令开头取快照显式传递（D4/D10）
- 依赖现值的写入走 `updateSettings(mutator, postCommit?)`：持锁、同步 mutator、写盘成功后才做文件副作用
- 跨进程锁只在数据根目录、以 `Lock` 结尾命名（paths.spec 按约定枚举断言）；会被 rmrf 的目录不放任何有生命周期的文件（锁、stage、epoch）
- 原子写 = 临时文件 + fsync + rename + fsync 父目录；崩溃遗留 `*.tmp` 由守卫之后按龄清扫
- 并发判据唯一：`epochChanged` / `startAbortedByConcurrentStop`（epoch）与 `describeExitCause`，调用点不散写第二份比较；基线由 main() 捕获为进程状态（D2/D4）
- 诊断事件只在 CLI 守卫后启用，固定白名单不记订阅名、原始参数、配置正文或错误正文；同步 O_APPEND、写失败静默，不进现有锁，不混入内核日志编号（D16）

### 配置与覆写

- 入站与控制面锁定的唯一真相是 constants.ts 的 `LOCKED_CONFIG_KEYS` 与实际执行集 `EFFECTIVELY_LOCKED_KEYS`（快照表 + tls）：告警扫描、剥除循环、脚本探针、快照 spec 全派生自它，不许重抄；判据与上游核对方法见 D5，完整性由 `config-inbound-snapshot.spec.ts` 兜底
- 合并闸门唯一出口 `selectActiveOverwriteFiles`；加载双路径（合并硬失败/诊断旁路）见 D7
- 覆写操作符（`key!` / `+key` / `key+`）只在顶层生效；带条件的变换一律写 JS 脚本（`export default (config, ctx) => {}`，契约见 D12–D14：就地修改、必须同步、返回值忽略）。status 不调用变换函数，但 ow/status 加载模块会执行顶层代码，doctor 构建会调用变换函数；status 的「生效」与 `overwrite.applied` 只表示选中，不证明脚本实际修改配置。脚本在 YAML 之前、剥锁定键之前执行，改不动系统锁定项；`~` / `~?` / `<x>` 已移除，写这些形态显式报错，不许静默当字面键
- match 的 name 只支持尾部 `*`（前缀）与头部 `*`（后缀）两种通配，其余报错——不引入通用匹配器（正则转义实现曾有灾难性回溯）；JS 脚本无 match 机制，作用域写在脚本里
- 配置解析只走 YAML（D6）；Mixed 清 tun 字段，TUN 强制 dns.enable=true

### launchd 与进程

- 改服务代码前读对应函数注释；锁内 launchctl 预算关系由 service-concurrency.spec 断言，新增锁内调用前先改测试（D3）
- 热重载成功不验、kickstart 回退必须健康确认（restartService 返回值语义）
- kill 前逐 pid 复核命令行，复核不匹配按「无事可做」计成功
- TUN 与服务共享 config.yaml，起 TUN 前必须关服务自启，两条方向都有并发防线

### 内核下载

- 镜像只作用产物下载、选择不持久化；版本查询代理可用时直接经代理（D8）
- 守卫前清 env 代理只清指向本机 Mixed 端口的自指形态（D9）；gh 回退与 npm 恢复两个 per-spawn 并存例外的判据与构造见 D9（共同前提「全程不重启内核」，均不写回 process.env）
- 下载候选由 `resolveDownloadChannels` 生成，逐个尝试首个成功即用；命令层不得额外追加 direct。代理运行时只有 proxy 与同代理 gh，代理未运行且 gh 可用时只有 gh；显式 --mirror/--proxy 只有一个候选（显式意图不自动换道）
- curl 子进程代理策略唯一出口是 `curl-spawn.ts` 的 `buildCurlSpawnEnv`：per-spawn env 置空 no_proxy/NO_PROXY 保 `-x` 权威；直连通道的 `--noproxy '*'` 在 args 层（buildKernelCurlArgs），proxy 通道 args 绝不能加 --noproxy；三处 spawn（产物下载/release API 查询/连通性探测）不得另写 env 代理处理
