# Changelog

## [26.10.108] - 2026-10-04

### 修复

- **`ui -c` 写剪贴板加 3 秒超时**：剪贴板服务（pboard）短暂无响应时 pbcopy 不再让命令无限挂死、Ctrl+C 前无任何输出，与读剪贴板侧既有超时对称

### 变更（内部加固，无用户可见变化）

- **手改 cache.json 的坏条目按无缓存处理**：单条被写成字符串/数字时不再展开成数字键垃圾对象，与 saveSubscriptionCache 同判据（新增不变量用例锁住）；`lsofListenPids` 注释如实写明 null/[] 三态不可达（lsof 对「无匹配」与 fatal 同退 1，消费方不得假设二者之别）；覆写文件排序键改为每文件只构建一次。961 用例全绿

## [26.10.107] - 2026-10-04

### 修复

- **curl 代理通道不再被 no_proxy 例外表静默改写**：shell 里 export 过 `no_proxy='*'` 或含目标域条目时，curl 会绕过显式 `-x` 直连——版本查询、内核下载、连通性探测三处 spawn 统一置空 per-spawn env 的 no_proxy/NO_PROXY（`curl-spawn.ts` 唯一出口，新增加 curl 必须经此）；direct 通道显式 `--noproxy '*'` 堵住另一类分叉——curl 默认读 `https_proxy` 等 env 代理，此前 `--mirror direct` 的「强制直连」实际会经 shell 代理出网，两条出网路径分叉、故障时还把原因误诊成直连被墙
- **订阅下载重定向逐跳校验 https**：改手动逐跳跟随、每一跳校验协议并设 20 跳上限，堵「先降 http 再跳回 https」的中间明文 hop——订阅 URL 的 token 常被服务器保留在重定向查询串里，旧守卫只看最终地址挡不住；错误消息对降级地址脱敏
- **启动 TUN 失败的恢复指引扩面**：关掉服务自启后任何一步失败（订阅校验/自动更新/配置构建/启动本身）都在错误里带「恢复 Mixed: `mihomo-cli start`」，此前只有启动失败分支带——只报「配置错误」会让用户以为一切照旧，下次开机才发现代理没回来
- **status/doctor 对坏状态容错**：手改 settings.json 写入非法订阅名不再击穿 status 整屏报错；doctor 内核版本检查失败带真实原因（「全部是预发行版」「未找到 curl」不再一律渲染成「GitHub 不可达」）；start 成功后的系统代理提示撞上坏 ports 配置时降级默认端口提示，不再把成功命令翻成 exit 1
- **`sub remove` 删最后一个订阅保留运行中提示**：此前按「切换目标」判定会把提示整个吞掉；没有可切换的新订阅时提示改为「（订阅已全部删除），重新添加订阅后执行 mihomo-cli start tun」
- **`reset service` 补残留进程提示**：纯重置服务此前把卸载透传的残留进程丢弃、「已重置: 服务」成了谎报，现在与 uninstall 同款式黄字列出 PID
- **覆写键 `++key` 加载即报错**：`++rules`/`rules++` 这类笔误此前静默落成字面顶层键不生效（内核对未知键宽容），`++secret` 还绕过锁定键告警；与 `key!+` 同口径报「操作符位置矛盾」
- **其余并发与容错修正**：内核配置校验的临时 stage 迁出会被整目录删除的 runtime/（并发 stop/reset 曾把校验配置一起删掉，把误诊指向毫无问题的订阅/覆写）；sudo 脚本名加 pid 后缀，双终端并发跑同一动作不再互踩「密码正确却报已取消」；启动过程中订阅被并发移除时给「已被移除」分档报错，不再指引必败的 `sub update <已删除名>`；热重载的控制器端口与密钥改同一份快照读取（settings 被原子替换时不再发新端口带旧密钥）；`-h` 提示文案与实际命令级帮助行为对齐

### 变更（内部清理，无用户可见变化）

- **/simplify 三轮收尾**：`firstLine` 收编全仓 12 处 `split('\n')[0]` 副本；卸载/重置残留提示与 bootout 未装载容忍码（3/113）收单点（TS 判定与 legacy bash 脚本生成共用一份码表）；控制器端口+密钥快照读收 `getControllerEndpoint`；CliError 再包装收 `relabelCliError`（exitCode 透传在结构上不可能丢）；「桩 curl 记录 no_proxy」端到端夹具收 test-support 新模块（三份逐字骨架合一）；http 手动跟随重定收单循环。960 用例全绿

## [26.10.106] - 2026-10-03

### 修复（覆写提示降噪）

- **未命中覆写脚本不再进配置告警**：start/update 顶部的黄色「配置提示: 覆写脚本 xxx 未返回 true…」与 status 的展示重复，措辞是脚本作者视角、使用者无事可做；`mh config` 提示段与 doctor 计数同步安静，配置告警只留真异常（脚本 ctx.warn、锁定键被剥除、TUN 强制开 DNS）
- **status 覆写区块收敛为一行**：不适用文件只计数不点名（`覆写: 已启用 (mini, seal，1 个不适用)`），逐行点名与「脚本未返回 true」术语不再暴露——想知道是哪个文件，对照 `mh ow` 列表的作用域栏；`status --json` 的 applied/files 契约不变
- **内部清理**：删除零消费的 `BuildConfigResult.scriptMatches` 字段与过期契约注释；status 用例负断言从锁句子改为锁文件名（换措辞恢复点名也能被测试拦住）


## [26.10.105] - 2026-10-03

### 变更（质量清理：测试基建单点化与白名单派生收单）

- **测试基建单点化**：假内核轮询步进改用进程内 `Atomics.wait`（此前每个 50ms tick 都额外 fork 一个 `/bin/sleep` 子进程）；两份同构的轮询循环合一（`waitForPids` 委托 `pollUntil`）；「写桩 + chmod」三份副本（npm 桩、launchctl 桩）收进 test-support 新原语 `writeStubExecutable`
- **start / ow / sub use 的选项白名单派生式收单**：三处各自复制的 `START_RESTART_FLAGS.flatMap(f => f.forms)` 改为 flags.ts 导出的 `START_RESTART_FLAG_FORMS`，与 `VALUE_FLAGS` 同范式，单表派生不再有表达式级拷贝
- 补齐上轮样板收敛的两处漏网（subscription.spec 的子进程 spawnSync 形态），清理死参数、零消费选项与纯文案字段；process-start.spec 的存活桩改 `exec` 单进程形态，收尾 pid-kill 即杀净、不再依赖孤儿 sleep 自然过期。对用户无行为变化（946 用例全绿）


## [26.10.104] - 2026-10-03

### 变更（全仓冗余收敛：单表派生化与跨文档收口）

- **start/ow 的选项白名单改由 flags.ts 单表派生**：此前两处手写同一份清单，将来新增 start 选项会漏同步（flags.ts「单表派生后漂移在结构上不可能」的不变量由此补全）；同时清理四个无消费方的导出与 logs 两处重复的用法提示，对用户无行为变化
- **测试样板收敛进 src/test-support/**：新增 `runModule`/`moduleUrl`（子进程跑真实源码模块的公共形态）、`fake-kernel.ts`（假内核落盘/起进程/判死/收尾，两份逐字副本合一）、`guard.ts`（守卫类 preload 骨架）；模块级子进程样板 15+ 处、桩 launchctl 与 npm 桩 setup、env 拼装与元数据键循环全部改用公共实现，行为覆盖不变（946 用例全绿，与上版的计数差只来自三组同构循环合一）。公共化顺带补上一个既有收尾缺口：`pkill -f` 模式杀不到桩 wrapper 里的 `sleep` 子进程（命令行不含模式串），每次跑残留进程组会漏成 launchd 孤儿，killLeftovers 现按记账的进程组 `kill(-pgid)` 补杀全组
- **跨文档双写收口**：控制器无鉴权说明只留 README 详版（SECURITY.md 改一句话 + 指针）、CLAUDE.md 的 D9 条目恢复指针式写法（细节见 decisions.md）、README 锁定键清单改类别级描述并指向代码里的 `LOCKED_CONFIG_KEYS` 唯一真相；两个高重合的 JS 覆写示例合一；release 流程补 CHANGELOG 补录纪律与主文件 10 版本滚动归档规则

