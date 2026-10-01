# Changelog

## Unreleased

### 修复

- **sudo 执行超时不再漏出内部错误串**：密码提示停留或脚本执行超过 60 秒时，此前用户看到的是 `spawnSync sudo ETIMEDOUT`，现改为超时提示并点明操作可能只完成了一部分
- **覆写 match 值加载期校验补齐**：`url-domain` 带协议、尾斜杠、端口、空格，或 `name` 精确值含非法字符时，文件会静默永不生效，现一律加载时报错；`rules!+`、`+~rules` 等操作符漏网形态同样拦下
- **帮助文案与实际行为对齐**：logs 用法行更正裸命令语义、version 用法不再内嵌别名、subscription use 补上自动重启说明；子命令名（如 `sub USE`）改为大小写不敏感

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

## [26.9.37] - 2026-09-29

自本版起版本号改为「年.月.序号」。本版序号记错（37 误取当月计数，应为全局计数 89），由 26.9.90 修正。

### 新增

- `mihomo kernel --proxy <端口|地址>`：显式指定出网代理，纯端口视为 `127.0.0.1:<端口>`，支持 `host:port` 与 `http(s)/socks5(h)` 地址；版本查询与下载共用，可与 `--mirror` 组合（镜像决定下载地址、代理只做传输），与 `--mirror direct` 互斥。mihomo 自己没在跑、但本机有别的代理工具时不再只能干等直连。
- 内核版本查询在**无代理可用**时走 gh 认证通道（`gh api`，配额 5000 次/时 vs 未认证直连 60 次/时）：此前本机明明装着已登录的 gh，版本查询仍走无认证 API，共享出口 IP 撞 403 限流时 gh 通道形同虚设；代理可用时直接经代理（在跑的代理就是已定的出网路径，先试 gh 直连只会把被墙的等待叠在前面），gh 失败自动回退直连，镜像仍绝不作用于 API。
- start（mixed）成功后的系统代理提醒按实际状态分档：用 `scutil --proxy` 检测当前生效网络集，已指向 Mixed 端口只一句确认（仍有条目指向别处时升级提醒），指向别处或未设置才给出可粘贴的 `networksetup` 命令（HTTP/HTTPS/SOCKS 三条）；PAC/WPAD 接管时只说明状态、不给覆盖命令；检测不可用回退原静态提示。
- `sub` 列表在全部订阅无流量数据且至少一个从未更新过时提示一句「更新订阅后可显示流量与到期」——刚 update 完仍无数据（机场不下发用量头）不再反复提示。

### 修复

- GitHub API 403 限流时的提示不再误导用户用镜像（镜像只作用于下载、解决不了版本查询的限流），改为指向真正的出路：等待限流重置或安装登录 gh 走认证查询。
- 拼错的镜像短别名（如 `--mirror cdnn`）此前被当自定义主机名放行、经 punycode 转换展示成一串认不出的主机且下载注定失败；现在按未知别名报错并给 did-you-mean。`--mirror 7897` 这类纯数字值提示改用 `--proxy`。含点/冒号的自定义主机名与完整 URL 的承诺行为不变。
- 帮助示例区首条从 `install` 改为 `kernel` 并按首次使用依赖顺序排列（kernel → sub add → install → start）——照旧示例敲的新用户第一步就撞「未找到内核」的墙。
- 裸 `--mirror` 后跟 `--proxy`/`-p` 的组合写法此前被参数校验误报「多余的参数」（四种等价形式里 exact 两种被拒、等号形式却通过）。
- `--proxy` 地址带认证信息（`http://user:pass@host:port`）时凭据被静默剥掉、连代理必 407 且报错无任何线索；显式写出的协议默认端口（`:80`/`:443`）被误报「需要端口」。
- gh 版本查询子进程超时从 120s 收紧到 10s：gh 无内建连接超时，直连被墙时挂满 120s 既拖慢回退链，也会在 doctor 弃掉查询后继续占住事件循环、推迟进程退出（doctor 的 4s 预算原本会被它整个耗干，「内核版本 ok」退化成 skip）。

### 变更

- `ow` 列表编号改为 1 基，与 `sub` 列表同口径（logs 的 `0=当前` 是特有语义，不受影响）。
- npm 卸载残留提醒的表述修正：经 registry 实测，npm 11.19.0 在全局/本地/`--prefix` 三种卸载场景下均不执行 preuninstall 生命周期脚本（官方文档亦注明 uninstall lifecycle scripts 未实现）——该提醒实际不会出现，卸载顺序的告诫不再依赖它；`scripts/preuninstall.mjs` 保留（未来 npm 恢复支持即生效），README 已如实改写。

## [4.14.0] - 2026-09-14

### 新增

- 命令级帮助：`mihomo help <命令>` 与 `mihomo <命令> -h/--help/help` 只显示该命令用法（此前三路都是报错）。
- `mihomo doctor` 新增内核版本检查：对比 GitHub 最新稳定版，落后时提示 `mihomo kernel`；GitHub 不可达或超时按「跳过」处理，不拖慢体检。
- `mihomo config --reveal` 显式查看凭据原文；`mihomo ui -c, --copy-secret` 显式把控制器访问密钥复制到剪贴板。
- npm 卸载时若检测到 LaunchAgent 服务或数据目录残留，打印手动清理提醒（升级触发同一脚本，忽略即可；不会自动卸载服务）。
- status 文本/JSON 与 `mihomo ui` 固定显示控制器实际端口——自定义 `ports.controller` 后托管 UI 默认连 9090 必然失败，而此前没有任何界面能看到该端口。

### 移除

- 移除 `mihomo completion` 与 `mihomo completion install`（shell 补全子系统）：该设施已长期损坏且无人维护（三 shell 词表手抄、多个分支生成内容错误），本机实测无任何用户；需要补全可自行参照 `mihomo help` 包装。

### 变更

- 覆写文件语法错误（含顶层写成数组/标量）不再只警告一行就跳过：`start`/`doctor` 改为硬失败并给完整原因；`mihomo ow` 与 status 诊断面不再被坏文件击穿，改为红字列出「加载失败」（`status --json` 新增 `overwrite.errors`）。
- `mihomo sub update`（无参批量）部分订阅失败时打印「N 个成功，M 个失败」汇总并以非零退出，此前 2/3 成功时退出 0，脚本与用户都发现不了失败项。
- 代理环境变量只在指向**本机自己的 Mixed 端口**时清除，指向企业代理或其他工具的 env 代理保留并透传给 npm/gh/curl——此前无差别清除会让只能靠 env 代理出网的用户 `mihomo update`/`kernel` 必败。
- 裸 `mihomo kernel --mirror` 固定走裸域 `gh-proxy.org`，不再猜测 IPv6（有 v6 地址不代表 v6 路由通）；纯 IPv6 网络显式用 `--mirror v6`。

### 安全

- `mihomo config` 默认递归脱敏节点凭据（`password`/`uuid`/`private-key`/`pre-shared-key`/`auth-str`/`secret`）与 provider 订阅 URL 里的 token；此前只脱敏顶层 `secret`，录屏或 `config | pbcopy` 会泄露节点密码与订阅地址。
- `mihomo ui` 不再默认把控制器密钥写入剪贴板（需显式 `-c`），避免静默覆盖剪贴板内容及经通用剪贴板同步到同 Apple ID 设备。

### 修复

- TUN 运行时执行 `mihomo kernel`，重启提示改为 `mihomo start tun`；此前提示裸 `mihomo start`，照做会静默切回 Mixed 并再要一次 sudo。
- TUN 启动被取消提权或失败时，错误提示说明服务自启已被关闭及恢复方式（disable 发生在弹密码之前）；启动成功后与 TUN 状态下的 status 常驻「停止: mihomo stop」收尾行。
- 内核更新成功后提示：使用局域网节点时首次启动可能重新弹出 macOS「本地网络」授权（此前只写在 README）。
- 内核 `-t` 拒绝配置的提示补上另一真实根因：订阅/覆写无误时可能是内核过旧、不认识新配置键，可尝试 `mihomo kernel`。
- `mihomo start` 无订阅时给出 `mihomo sub add <url>` 命令；订阅有条目但本地配置文件缺失时，start 与 config/doctor 统一指向 `mihomo sub update <名称>`（此前 start 误导为重新添加）。
- 裸 `mihomo reset` 及显式 `reset subs` 的确认计划挑明「订阅链接与本地配置将被删除且无法恢复」。

## [4.13.0] - 2026-09-13

一项入站安全边界修复，并给锁定清单补上防漏机制。单测 700（+11）。

### 安全

- **订阅/覆写里的 `allow-lan` 等六个键不再进运行配置**：`allow-lan`、`bind-address`、`authentication`、`skip-auth-prefixes`、`lan-allowed-ips`、`lan-disallowed-ips` 是上游 `config.Inbound` 里与已锁的 `ss-config`/`listeners` 并列的字段，此前从未被剥除。远端订阅一行 `allow-lan: true` 就让内核把混合端口从回环绑到全网卡，而 `skip-auth-prefixes: ["0.0.0.0/0"]` 会让唯一的补偿防线 `authentication` 整个失效——三行 YAML 即可把本机变成全网卡无鉴权开放代理，与 README「入站默认关闭」的承诺直接冲突。判据与已锁的入站键完全相同，只因形态是布尔/字符串而非映射或 URL 被漏看

### 变更

- **`allow-lan` 现由本工具恒定为 `false`，订阅与覆写都改不了**（上一条的直接后果）。此前 README 写着「可在订阅或覆写中显式开启」，该说法把远端下发的订阅当成了用户的意图表达，与「订阅不可信」这一整套锁定机制的前提矛盾。**破坏性变更**：靠订阅或覆写开局域网入站的用户会失去该能力（覆写侧有提示，订阅侧按既有设计静默）——确需局域网设备连入请在本机另起一个 mihomo 实例。同理，`authentication` 被锁后不能再经覆写给混合端口设代理鉴权；混合端口现固定只监听回环，局域网威胁面已不存在
- `iptables` 之外，`inbound-tfo` / `inbound-mptcp` 也明确记为刻意不锁：传输层 socket 选项，不开监听、不改绑定地址、不绕鉴权

### 新增

- **锁定清单新增字段快照测试**：`LOCKED_CONFIG_KEYS` 已连续五轮各漏一批入站键，每轮复审都写着「这次逐个核对过了」。现存一份带上游版本号的 `config.Inbound` 字段快照，凡不在锁定表里的字段必须写明放行理由，否则测试失败——「待定」在实现上等于放行，这类决策不能再静默通过。该快照是冻结副本，发现不了上游新增字段，内核大版本升级时仍需人工刷新

## [4.12.0] - 2026-09-13

全仓复审修出的十一项：两项入站/文件安全边界、六项修复、两处词表与文案收口、一项性能。单测 689（+32）。

### 安全

- **订阅/覆写里的 `listeners` 与 `tunnels` 不再进运行配置**：两者自带监听地址、不受 `allow-lan` 约束，远端订阅一条 `listeners: [{type: socks, listen: 0.0.0.0, port: 18080}]` 即可在全网卡开出无鉴权 SOCKS 入站。判据与已锁的 `ss-config`/`vmess-config`/`tuic-server` 完全相同，此前因被记作「未定的产品决策」而放行了三个版本。确需额外入站请在本机另起实例；`iptables` 仍保留（Linux 专用、非监听）
- **`completion install zsh|fish` 不再覆盖非本工具生成的同名文件**：此前是无条件写入，用户手写或第三方分发的 `~/.zsh/completions/_mihomo` 会被静默销毁且无备份。判据与 `uninstall` 的删除守卫收口为同一条——此前卸载侧严格把关、安装侧直接覆盖，守的那道形同虚设（覆盖之后指纹就匹配了，卸载反而删得干干净净）

### 修复

- **`status` 把主覆写文件显示成 `yaml`**：剥前缀与剥扩展名的顺序写反，`overwrite.yaml` 剩下 `yaml`、「主文件」兜底永不触发。只有一个主文件是最常见的配置形态，该行现显示 `覆写: 已启用 (主文件)`
- **`--mirror` 重复时的提示指向一个会报错的命令**：原提示「可用镜像见 `mihomo kernel --help`」，而命令级 `--help` 并不存在（只是顶层 help 的别名），照做会得到「未知的选项」。改为直接列出可用镜像
- **`eval "$(mihomo completion zsh)"` 实际不注册补全**：脚本结尾是裸调用 `_mihomo "$@"`，eval 下 `#compdef` 只是注释，裸调用则在补全上下文之外执行 `_arguments` 并报错，而 `eval` 仍返回 0——用户照 README 做了却发现补全不工作。改为 `compdef` 注册，两条安装路径（fpath 文件 / eval）现在都生效
- **bash 半截标记块导致 install 与 uninstall 互相甩锅**：`~/.bash_completion` 只剩起始标记时（手工编辑或上次写入中断），install 报「已安装过」、uninstall 报「未找到标记」，双双退出 0 且都不改文件，用户没有 CLI 路径可修。install 的幂等判据改为要求成对标记，可自愈
- **zsh 补全描述里的撇号被静默吞掉**：转义用了 `''`，而该写法仅在 `RC_QUOTES` 选项下才是转义（默认关闭），默认下是字符串拼接。改用 `'\''`。当前注册表无此类描述，属预防性修复
- **fish 补全描述以反斜杠结尾会让脚本语法错误**：只转义了撇号、未转义反斜杠，`-d 'desc\'` 的末尾 `\'` 被读作转义撇号。同为预防性修复
- **`settings.json` 内容是 JSON 合法的非对象时被静默丢弃**：`[1,2,3]`、`"str"`、`42`、`null` 这几种形态此前既不备份也不告警，而下一次写设置会把文件整个覆盖成默认内容——用户原件无声无息地没了。现与「JSON 解析失败」同样备份到 `.bak` 并告警
- **bash 补全有重复标记块时需卸载两次**：`uninstall` 只切第一对标记就报「已移除」，文件里仍留着一份生效的 `_mihomo_completions` 定义。现循环剥离到一个不剩，多份时如实告知移除了几份

### 变更

- 补全的两处硬编码词表改为从单一真相源派生：bash 的 `dir` 分支不再写死 `open`（改用 `DIRECTORY_SUBCOMMANDS`），fish 的目录目标行不再写死四个 `directory` 别名（改从注册表取）。此前给 `directory` 加别名或子命令时，相邻的派生分支会跟上而这两处不会
- 不接受任何选项的命令（`completion`/`dir`/`stop` 等）在选项报错时不再打印空的「可用选项: 」，改说「该命令不接受任何选项」；`-h`/`--help` 额外点明它只在顶层可用。`completion install|uninstall <shell>` 的 shell 名报错也带上自己的动词，照提示改不会丢掉 `install` 这一步

### 性能

- **`doctor` 的 npm 版本查询改为与本地检查并行**：该查询是纯网络往返（约 780ms），原先串在全部检查之后，而它不依赖任何前序结果。装了内核时体检从约 1070ms 降到约 837ms（省 22%）；未装内核时本地检查太短，耗时下界即 npm 查询本身

## [4.11.0] - 2026-09-13

一处展示层误导的修复：`status` 此前会把「不适用于当前订阅」的覆写文件与真正生效的并排列出。单测 657（+8）。

### 变更

- **`status` 的覆写行区分「生效」与「不适用」**：此前括号里列的是「目录里没被 `enabled: false` 停用的文件」，不按 `match` 过滤——只对别的订阅生效的文件会和真正生效的混在一行里，长得一模一样。用户拿它解释自己看到的行为（「我明明覆写了」），排查方向整个跑偏。现主行只列本次真正参与合并的文件，未命中的每个展开一行说明原因：`glados 不适用于当前订阅 mini1（作用域 name=edu*）`——文件名、当前订阅、作用域三者凑齐才看得出为什么没命中。两类失效分开计数而不合并成一个数字：「不适用」要改 `match` 或切订阅，「已禁用」要改文件里的 `enabled`，原因与改法都不同。status 判得了 match 是因为它知道当前活跃订阅，而 `mihomo ow` 列表不绑定某条订阅、判不了也不该判，那里维持原样（`listOverwriteFile` 不传 scope 时 `matched` 为 undefined = 未判定，与「未命中」区分）。判据仍是 `matchesScope` 本身，合并闸门也仍只有 `selectActiveOverwriteFiles`——新增的 `matched` 只供展示。反向验证：让 status 不传 scope，5 条新用例转红，另 2 条（`ow` 列表不判 match、全命中时无补充行）按设计恒绿

### 新增

- **`status --json` 新增 `overwrite.applied`**：本次真正参与合并的覆写文件清单，三道过滤与 `buildConfig` 对齐（全局开关 → 文件级 `enabled` → 当前订阅的 `match`）。`overwrite.files` 保持旧契约不变（只滤文件级 `enabled`，不按 match、不随全局开关变空），两者并存以免破坏既有脚本

### 修复

- **`applied` 漏了全局开关这道过滤**：上一条提交自引入，复查时实跑发现。`ow off` 之后同一份 JSON 里 `enabled` 是 `false`、`applied` 却列着文件，而人读形态此时只说「已禁用」、一个文件都不列——两种形态对不上，也与 `buildConfig` 的实际行为不符（全局关闭时它压根不加载任何覆写文件）。根因是契约注释先写错、实现照着错契约写，现三道过滤对齐并补回归用例

## [4.10.0] - 2026-09-13

覆写作用域与单文件开关两项增强，并堵上三个相邻的静默失效。单测 649（+46）。

### 新增

- **`match` 支持按订阅名通配限定作用域**：新增 `name` 键（与既有 `subscription` 同义，推荐写法），值支持 shell 风格 `*` / `?` 通配，如 `match: {name: edu*}`。此前同机场的多条订阅（`edu1`/`mini1` URL 同域名）只能逐条列举订阅名，或退回 `url-domain` 把整个机场一并命中，无法按套餐系列区分。通配为**全串匹配**（`edu*` 不命中 `xedu1`，半匹配会让作用域悄悄放宽），不含通配字符时退化为精确比对、老写法行为完全不变，`.`/`+` 等字符按字面处理。匹配走双指针贪心回溯而非正则——初版转义成正则的写法有灾难性回溯，`*a`×20 配 64 字符订阅名实测 70 秒，而 64 正是 `SAFE_NAME_RE` 的长度上限，合法输入就能挂死 CLI（复审时实测发现，新实现同组输入 0ms，与旧版做过 30 万组差分测试结果一致）。两个同义键内部归一到单一字段，判据只有一处；同时出现直接报错（无法判断以谁为准），但展示层回显用户实际写的键名——`ow list` 与内核拒绝提示若显示一个在文件里搜不到的键名，用户无从按图索骥。反向验证：去掉全串锚定 3 条转红、换回正则实现整个测试文件 60s 跑不完
- **覆写文件顶层 `enabled: false` 可单独停用一个文件**：此前只有 `ow off` 全局总开关，或把文件改名成 `.bak`——后者会让文件从 `ow` 列表里消失，过阵子就忘了还有这份配置。被停用的文件仍完整加载、校验 match 并列在 `ow` 中标注 `[已禁用]`（避免停用期间藏着错误、一启用就炸），只是不参与合并。**只认真布尔**：YAML 1.2 里 `no`/`off` 解析为**字符串**而非布尔（实测 js-yaml 5.3.0），按 truthy 处理会让 `enabled: no` 悄悄保持启用——用户以为停用了、配置却照常生效，故非布尔一律报错并指明写 `false`。与 `match` 同为元数据键、加载时剥离：内核对未知顶层键宽松（实测 `mihomo -t` 放行 `enabled: false`），拦不住要靠 CLI 自己。反向验证：去掉过滤 2 条转红、非布尔按 truthy 1 条转红

### 修复

- **元数据键带操作符可绕过剥离**：`enabled!: false` 既不会停用文件，又会被 `parseOverrideKey` 规范成键 `enabled` 落进最终运行配置——剥离发生在解构、早于操作符解析，两头落空，正是本次新功能要消灭的那类「以为停用了其实生效」。`match!` 是同族存量洞（在 `match` 引入时就在，一直没人写过这种形态所以没暴露）。现统一报错并指明直接写 `match:` / `enabled:`；嵌套层同名普通键（如 `dns.enabled`）不受影响
- **元数据键的大小写/空白变体同样绕过剥离**：YAML 键区分大小写，`Enabled: false` 既不停用文件（剥离用精确键名）又不是任何 mihomo 原生键，会原样写进运行配置，而内核对未知顶层键不报错——用户完全没有反馈。与上一条是同一种静默失效，只是走大小写这条路。判据为「小写去空白后等于 `match`/`enabled`、但原样不等于」，与 `isOverwriteFilenameTypo` 同一思路（只认整体近失，`enabled-by`、`matcher` 这类形近无关键不误伤）
- **`*` 开头的通配值会让整个覆写文件被静默跳过**：YAML 里 `*` 开头是别名语法，`name: *edu` 解析失败后只打一行「解析失败」、文件不加载。推广订阅名 glob 后前缀通配是很自然的写法，故在解析失败提示里针对 alias 错误追加「请加引号写成 `name: \"*edu\"`」

### 变更

- `filterOverwriteFilesByScope` 更名 `selectActiveOverwriteFiles`，`enabled` 与 match 两道过滤合在这一个出口。并列两个导出函数迟早有调用方只调一个，停用文件就会照常合并进配置、还出现在「当前生效的覆写文件」清单里；这类「防线消费点不止一处」的缺口在本仓并发状态机上连修三版才补齐，不想在覆写侧重演一遍。`listOverwriteFile` 是有意的旁路（列表要显示全部文件）
- `status` 的覆写行与 `--json` 的 `overwrite.files` 只报生效文件（JSON 契约仍是 `string[]`），有停用文件时人读形态补一句「N 个已禁用」；`ow` 列表在有停用文件时于标题补出未禁用数，并补一行「停用单个文件」的用法提示——看到 `[已禁用]` 却不知道怎么改回来是最直接的死路。计数措辞用「未禁用」而非「生效」：该列表看不到活跃订阅、无从判断 match 是否命中，与内核拒绝提示里那份真·生效清单刻意区分

### 测试

- 新增 `src/commands/overwrite.spec.ts`（CLI 级，8 条）：`ow` 列表与 `status` 的展示此前完全无覆盖，而「被停用的文件仍要列出并标注」是产品承诺——若日后改成加载时直接丢弃，纯单元层面 `selectActiveOverwriteFiles` 照样为空、测不出来。反向验证：改成丢弃后 4 条转红

## [4.9.2] - 2026-09-12

复核 v4.9.1 的 CODE_REVIEW 声明本身时发现的锁定清单遗漏。单测 603（+4）。

### 安全

- **订阅一行 `ss-config` 即可把本机变成带密码的 Shadowsocks 开放代理**（`vmess-config` 同理）。4.9.1 补 `tuic-server` 时声称「回上游 General 段逐键核对」，实际漏了同一个 `config.Inbound` 结构体里紧挨着的另外两个入站服务端——三者同由 `hub/executor.updateListeners()` 逐个 `ReCreate*` 起监听，只因 `tuic-server` 是映射、这两个是一行 URL 而被漏看。上游 `ParseSSURL`/`ParseVmessURL` 把 URL 的 host 直接当 `Listen`，`New()` 再对 `strings.Split(Listen, ",")` 逐个 bind，且**不经过 `genAddr`**——`allow-lan: false` 与 `bind-address` 对它们完全无效（那两个只作用于 HTTP/Socks/Redir/TProxy/Mixed），所以「入站默认关闭」这条 README 承诺挡不住它。两键进 `LOCKED_CONFIG_KEYS`（订阅与覆写一律剥除，告警仍只对生效的覆写文件），并补一条用例锁死「剥除不能依赖 allow-lan」这个判据。反向验证：摘掉两键恰好 4 条新用例转红

### 文档

- CODE_REVIEW 修正两处与事实不符的记述：v4.9.1 已发布却仍写「待发布」、既有防线回归一格的测试数停在 596（`d4eb38b` 补 3 条后未同步）。并记入一条新的未覆盖项——锁定清单与上游 `Inbound` 字段集之间没有自动比对，连续三个版本各漏一批键，每轮都以为已逐个核对过；对表方法（照结构体字段 + `updateListeners()` 入参，而非按键名眼熟程度挑）写进 CLAUDE 与 `LOCKED_CONFIG_KEYS` 注释

## [4.9.1] - 2026-09-12

4.9.0 发布后的全仓复审（自审并发状态机全线 + 三个分模块深审，重要线索逐条实测或回上游源码核实）。修掉 15 项：入站/控制面安全边界（含复审末尾回上游 General 段补出的 `tuic-server`/`external-doh-server`）、一条热重载自愈缺口，其余是一致性收口。单测 599（+48）。

### 安全

- **订阅可偷偷开出第二个、无鉴权的 external-controller，甚至一个入站代理服务端**。4.9.0 把 `redir-port`/`tproxy-port` 补进锁定删除清单时，漏了整个入站/控制面家族：上游 `config.go` 的 General 键 `external-controller-tls`（配合顶层 `tls:` 段给证书即可在 `0.0.0.0` 再开一个 TLS 控制器）、`external-controller-unix`（任意路径 unix socket 控制器，无前置条件）、`-pipe`/`-routing-mark`、`external-controller-cors`（直接放宽现有回环控制器的浏览器跨域）、`external-doh-server`（控制器上挂 DoH 端点）、`tuic-server`（**完整入站代理服务端**，配置内嵌证书/认证字段，订阅借此可把本机变成监听全网卡的开放代理——比透明端口严重）。订阅是远端不可信内容，而 CLI 又剥掉订阅自带的 `secret`、默认不设密钥——机场可让同网段设备或任意网页直接操作内核，打破 README「控制器仅监听回环」「入站由 mixed/tun 托管」两条承诺。锁定项收成 `LOCKED_CONFIG_KEYS` 一张表（含顶层 `tls` 证书段），Mixed/TUN 共用；以后新增入站/控制器键只改这一处，不再零散 delete。每个键已对照上游 `MetaCubeX/mihomo` 源码确认内核识别，行为实测。`listeners`/`tunnels` 两个通用入站声明与 `iptables`（Linux 专用）本版不锁——前两者是否允许订阅投递是未定产品决策、须一起评估，已记入 CODE_REVIEW 并用测试锁住现状
- **锁定项告警源只对订阅、会对真实机场订阅刷屏**。最初实现对订阅与覆写一视同仁地告警，但机场订阅几乎必带 `mixed-port`/`socks-port` 等端口段，系统约束接管订阅入站本就是核心设计、用户没有行动手段——每个用户每次启动都会看到一条无法消除的黄字。改为剥除不看来源、**告警只对生效的覆写文件**（亲手写覆写的用户才会以为键生效），文案带文件名并识别 `+key`/`key!` 操作符形式；未命中当前订阅作用域的覆写不告警。热重载请求的 Authorization 头同步加字符串类型守护

### 修复

- **热重载探测的首个状态查询在兜底 try 之外**：`tryHotReload` 里的 `getServiceStatus()`（launchctl print/print-disabled，可能退 112/125 或超时）一旦抛错，不履行函数注释「返回 false 即回退 kickstart」的契约，而是让 `start`/`sub use`/`ow` 整体失败——launchd 病态时恰恰最需要 kickstart 自愈。探测全程（含 `getPorts`）收入 try，桩 launchctl 计数场景（入口查询成功、热重载查询退 112、kickstart 后恢复 running）端到端验证回退并通过健康确认；反向验证：查询移回 try 外用例即红
- **zsh/fish 补全卸载的身份指纹过弱**：zsh 指纹是 `#compdef mihomo`——这是 compinit 对每个 `_mihomo` 补全要求的固定首行，用户手写或第三方分发的同名补全必然以它开头，`completion uninstall zsh` 会误删别人的文件，与函数注释的保护承诺相反。指纹改为本工具独有的完整行 `#compdef mihomo mhm mh mihomo-cli`；fish 同族收紧到四别名循环行。两条「弱指纹文件拒绝删除」用例锁死，反向验证旧指纹即红
- **非字符串 `controller_secret` 绕过脱敏**：settings.json 手误写成数字/布尔时，`config` 两个出口的 `typeof === 'string'` 条件都不成立、明文上屏（`config` 不跑内核校验）。`buildConfig` 唯一消费点对齐 `getPorts` 的 fail-closed：非字符串直接报「配置错误」；展示侧脱敏也不再依赖类型判断
- **内核下载的 curl 没有 `--fail-with-body`**：镜像/CDN 返回 404/500 的 HTML 错误页时退出码 0、错误内容落盘，最终只报「文件大小与 release 元数据不符」，真正的 HTTP 原因丢失（4.9.0 只修了 release API 查询通道）。下载通道对齐；退出码 22 翻译为「镜像或服务器返回 HTTP 错误」
- **tar 解压无总量上限（压缩炸弹）**：`--max-filesize` 只卡压缩后体积，高压缩比 tar 可解压上千倍撑满磁盘，而镜像通道不可信、产物又以 root 运行。`tar -tvzf` 列表阶段汇总条目字节（`parseTarEntrySize` 同时认 bsdtar/GNU 两种列布局），超 512MB 拒绝解压；`.gz` 单文件路径原有 256MB maxBuffer 兜底
- **内核校验超时分支的 hint 仍引导「修正订阅或覆写」**：超时与配置内容无关，也不该附覆写清单；`buildKernelRejectHint` 加 `timedOut` 形态，尾行指向内核/系统异常
- **命令层空串与选项口径不齐**：`ui ""`、`dir open ""`（变量展开为空的笔误）此前静默走默认（打开 zash/根目录），改为未知名称/目标报错；UI 名称统一小写归一（`ui DASH` 等价 dash，抽出 `resolveUiName` 纯函数与 `resolveStartMode` 同范式）；`sub update ""` 此前静默更新**所有**订阅（还可能触网），改为报「请指定名称」与无参区分；`sub use`/`ow on|off` 的 `-u` 即使未运行、不触发重启也先校验（`ow on -u` 缺值不再静默成功，新增 `assertRestartOptionValues`）；`kernel --mirror x --mirror y` 显式报「只能指定一次」而非取第一个；裸 `ow -s`/`dir -x` 在子命令位置给「未知的选项」文案；Ctrl+C 的「正在退出...」改走 stderr，不再污染 `status --json`/`config --json` 的 stdout
- **settings.json/cache.json 损坏备份只有一份且会被覆盖**：「损坏→备份原件→回退默认写回→再次损坏」会用默认内容/新损坏盖掉唯一的用户原件；`.bak` 已存在时保留更早那份，警告文案说明
- **补全词表/选项漂移**：reset 补全只给主名不给命令实际接受的别名（`sub`/`log`/`ow`/`config`/`core`），改为从同一别名表派生；三 shell 都漏了 `--yes`；fish 把 `-y` 与 `--full` 错绑成一行（`-s y -l full` 让 --full 的短写变成 y），拆为两个独立选项；fish 安装位置不认 `XDG_CONFIG_HOME`，设了就落在其下的 `fish/completions`

### 行为变更

- **`config --json` 输出改为信封 `{ "config": {...}, "warnings": [...] }`**：4.9.0 把 warnings 铺在顶层，会顶替配置自身的同名顶层键（mihomo 无此键，危害仅限输出与 YAML 出口不一致），且让「JSON 内容 = start 写入内容」少了一半。信封与 YAML 出口的「配置正文 + 提示段」同构；无警告时 `warnings` 仍是空数组。4.9.0 同日发布，预计无下游消费者
- **矛盾的覆写操作符组合显式报错**：`+rules+`（前插+追加）、`~dns!`（按名合并+整体覆盖，显式 `!` 被静默忽略）、`<x>+!` 等此前按分支优先级静默取其一；裸 `+:`/`~:`/`!:` 产出空字符串顶层键（内核忽略，笔误零反馈），一并报错。`~?` 仍是 `~` 的变体不算组合，`<+key>!` 等合法单一操作符不受影响

### 复审排除项（实测后判定不是缺陷）

- 子审查报「`sudo pkill -f <PATTERN>` 会匹配自己的命令行杀掉 sudo 父进程」：对照实验证明真实 pattern **不**自匹配——`escapeRegExp` 把点转义成 `config\.yaml`，命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点（对照组把 `\.` 换回 `.` 立刻自匹配）。三个 root 脚本同此结论，不加行首锚
- 文件锁强夺/释放是 stat→unlink 两步、不复核 inode：仅在等待者被冻结（合盖/换出）且系统时钟前跳时可利用，微秒级窗口，记为已知理论缺口，不为此加机制
- 两个 start 互相并发的「假失败」窗口、矛盾的 `start tun`/`start` 并发：不受支持的并发操作，终态仍由后执行者决定、doctor 可诊断，与已记录的 kickstart 交错同类

## [4.9.0] - 2026-09-12

对全仓做一次分模块深审（launchd 与进程、数据锁与下载、配置构建与覆写、命令层与横切），修掉 16 条：三条实测复现的并发缺陷（文件锁 deadline 删新鲜锁、TUN 运行中配置变更被切回 Mixed、热重载成功不复读停止计数）、覆写嵌套键语义统一为字面（行为变更）、以及一批「承诺写在注释、机制没盖到」的一致性缺陷。单测 550（+210）。

### 修复

- **端口单侧覆盖可撞上另一侧默认值，产出无法启动的配置**。`getPorts` 的「不能相同」校验只在两侧都显式配置时执行：`{"ports": {"mixed": 9090}}` 会得到 mixed 与 controller 都是 9090 而不报错，内核 `-t` 只做解析照样通过，真正启动时第二个监听 bind 失败——doctor 的端口项还会显示「9090 空闲 ok」把排查方向带偏。校验改为在合并默认值**之后**执行，撞默认值时的报错会指明撞的是配置值与哪一侧默认
- **订阅自带的 `redir-port`/`tproxy-port` 泄漏进运行配置**。删除清单此前只有 `port`/`socks-port`：订阅写 `redir-port: 7893` 时内核会多开一个透明代理入站监听，与「入站端口是系统锁定项」矛盾。两个端口进删除清单（Mixed/TUN 共用同一张表）；`listeners` 是否同删属未定产品决策，本版未动。`validateConfigWithKernel` 的 `overwriteSummaries` 参数同时去掉可选默认值——透传快照一律必填是 v4.8.0 六条并发缺陷的教训
- **TUN 运行中执行 `sub use` / `ow` 切换会静默切回 Mixed 并弹 sudo**。`restartToApply` 的「要不要重启」看实际运行状态（含 TUN），「按哪种模式重启」却只看服务是否已装——而「stop → start tun」是文档明示的正常流程。后果：切个订阅，实际发生的是盘上配置先被覆写成 Mixed、随后弹 sudo 要杀 root TUN 内核，输密码则全局路由静默消失。新增 `restartModeFor`/`restartModeOnChange`：模式取实际在跑的东西（TUN 在跑即 tun），真实桩内核 + pid 文件端到端锁死；更新后的提示文案同步按模式给 `start` 或 `start tun`
- **`config --json` 与 doctor 丢弃 buildConfig 的 warnings**。`~?` 补丁因分组拼错全部被跳过时，JSON 消费者毫无感知、doctor 照样报「配置 ok」——恰是最需要提示的一刻。warnings 现作为顶层字段进 JSON 输出（空时为数组），doctor 把它挂到配置检查项的 notes（检查仍算通过，计入警告不计入异常）
- **补全脚本四份词表脱离单一真相源**。completion.ts 头注释宣称「不再手写第二份词表」，但目录目标、UI 名单、镜像别名、reset 目标是硬编码副本——给登记表加一个别名，命令认、补全不提示，且无测试比对。四份全部改为从 `DIRECTORY_TARGETS`/`UI_URLS`/`MIRROR_ALIASES`/`RESET_TARGETS` import 派生，配「接线测试」（期望值也从同一 import 派生，锁接线不锁快照）。顺带：fish 补全在 `dir <TAB>` 位置就提供目录目标（bash/zsh 有 gating，fish 没有）已对齐；bash/fish 缺失的镜像别名与 reset 目标提示补齐；`logs -f` 的 close 处理器里不可达的 signal 死分支（全局 SIGINT 恒先 exit 130）删除、注释改为与真实行为一致
- **`withFileLock` 的 deadline 兜底会删新鲜锁，破坏等待者互斥**。等待超 10s 的兜底分支不查锁龄直接 rmSync 任意锁、且 continue 后不睡眠——三进程实测（A 持锁 12s，B、C 排队）：B 按陈旧路径正常强夺，C 过线后无条件删掉 B 刚建的锁，B/C 临界区重叠 1.24s。真实触发面是 service.lock：慢速 start 期间另一终端 stop + 第三个终端操作，两个等待者同入 launchd 临界区。deadline 路径改为只强夺陈旧锁（与正常路径同一锁龄判据），新鲜锁继续睡眠重试——活性由锁龄保证，任何锁持有超 10s 必然变陈旧可强夺。三进程编排测试锁死「双等待者临界区不重叠」
- **sudo 路径三处收口**：`killAllMihomo` 的 sudo 分支超时 15s（`sudo.ts` 自己声明的统一上限是 60s）——密码输慢了被杀后误报「部分进程未终止」，改为引用 `SUDO_TIMEOUT_MS`；legacy 清理脚本用 `exit 1` 报真实失败被渲染成「已取消或密码错误」（1 留给 sudo 鉴权、脚本内部失败用 ≥2 是仓内约定），改 `exit 3` 并登记准确文案；`cleanupRootResidue` 的普通 Error 从 stop/uninstall/reset 裸露、带完整堆栈按未预期错误渲染（同族已有 `cleanupLegacyInstallOrThrow` 包装范式），四个消费点统一走 `cleanupRootResidueOrThrow`，报错说清「主体动作已成功、root 残留仍在、如何重试」
- **内核版本查询的网络路径三处**：代理分支 curl 未加 `--fail`——api.github.com 限流 403 时退出码 0、报笼统的「无法获取版本信息」并把排查方向指向镜像（直连路径会正确显示 HTTP 403 与原因），加 `--fail-with-body` 并复核状态码（3xx 不跟随时退出码也是 0）；同一查询用 `spawnSync` 阻塞事件循环最长 130s、spinner 冻结 SIGINT 延迟，改异步；https 判定 `url.startsWith('https://')` 可被大写 scheme 绕过降级守卫，改 `new URL().protocol` 判定。真实 CONNECT 隧道代理端到端验证过取到真实版本号
- **归档名分配是跨进程 TOCTOU，并发轮转静默覆盖归档**。`existsSync`-then-`rename` 只防同进程同秒两次轮转；双终端同时 start（或 start + tun）时都判否、选同一归档名，后到的静默覆盖先到的——一份历史日志无提示丢失。改为 `openSync('wx')` 原子占名（与文件锁同范式），EEXIST 即换序号，service 三个消费点零改动；并发输家路径的裸 ENOENT 顺带收口。fake-ip 默认 sniffer 注入（11 行硬编码）全仓零测试一并补上，含 `sniffer: null` 边界口径（内核把 null 解码为零值，不注入是正确行为）
- **命令层杂项五处**：多余位置参数静默忽略（`start mixed garbage` 照常执行），与「未知输入统一报错」的边界不对称——全部消费点校验位置参数个数，25 拒 19 放行用例锁死；`NO_COLOR=` 空串也关色（no-color.org 规范是存在且非空才关）；CliError 渲染走 stderr 却按 stdout 的 TTY 判定设色（`mihomo status | grep x` 时错误输出被剥色）；`uncaughtException` 假定 Error、非 Error 渲染成「未捕获的异常: undefined」（与 unhandledRejection 口径不一致）；`dispatchSubcommand` 的子命令表无重复 token 防护（registry 有、它没有——撞别名静默取先注册者）。`clearProxyEnv` 的副作用（企业 env 代理网络下 `mihomo update` 会直连失败）补进 CLAUDE.md
- **覆写操作符只在文件顶层生效，嵌套键一律字面（行为变更）**。此前嵌套映射的内层键「目标有同名键→继续按 DSL 解析、没有→整棵字面移植」——同一份覆写在不同订阅上行为不同：mihomo 原生通配键（`nameserver-policy` 里的 `+.corp.example.com`）在递归路径被静默剥掉 `+`（`-t` 照样过、通配匹配悄悄失效），README 文档化的 `<+.google.cn>` 转义在最常见路径（订阅无 hosts）下尖括号连字面进配置、永不匹配——没有任何一种写法在两条路径下都正确。统一为：操作符只在顶层解析，嵌套键（含 `~key` 元素补丁的字段）一律字面，`+.域名` 通配键两条路径都安全；形似操作符的嵌套键（`~x`/`x!`/`x+`/`<...>`）经 warnings 每文件每键提示一次「已按字面处理」（`+.` 开头的原生通配不提示）。追加嵌套数组改写成全量值。顶层转义组合 `~<key>`/`~?<key>` 补全，`overwrite.yml` 近失文件名在加载/列表入口提示一行。反向验证：恢复内层 DSL 解析后九条用例转红

- **`sub` 的选项校验按子命令收口，不再全组放行**。校验原本挂在子命令分发之前，白名单是 `use` 的重启透传选项与 `remove` 的 `-y` 的并集、对全部子命令生效：`sub add <url> <name> -y` 被接受但 add 根本不读 -y（纯静默忽略），`sub update -u 5000` 被接受却仍按默认超时跑，`sub remove foo -s` 被接受无任何效果——正是 `assertKnownFlags` 文档注释要防的「用户以为选项生效了，实际行为完全没变」。白名单下沉到 `SUBCOMMANDS` 表：分发命中后先按该子命令真正消费的选项校验再执行——add/update 不消费任何选项（白名单为空），use 放行重启透传集合（从 flags.ts 的 `START_RESTART_FLAGS` 派生，与 `extractStartOptions` 单表同源），remove 放行 `-y`/`--yes`；错误提示同样只列该子命令的可用选项与用法，不再报全组清单。选项出现在子命令位置（如 `sub -q`）按未知选项报错。
- **`help` / `version` 在豁免场景下不再创建数据目录**。三个守卫（Node 版本/平台/root）对纯信息命令提前放行，但 `ensureDirs()` 无条件执行——实测伪造 root 跑 `sudo mihomo version` 正常退出，却在 root 的 HOME（sudo 下可能是 `/var/root`）建出全套 `data/kernel/logs/runtime/subscriptions`；非 macOS 上的 `mihomo help` 同理。豁免语义此前只免了「拒绝」没免「副作用」，与 index.ts 两处注释（「纯信息命令不碰服务、目录与提权」「root 下会在那里建一套用户永远看不到的数据目录」）直接矛盾。豁免名单（`GUARD_EXEMPT_COMMANDS`）现在同时决定是否跳过 `ensureDirs`，按 `command.name` 匹配，别名（`-h`/`-v`/`--help`/`--version`）经 `findCommand` 解析后自动覆盖；非豁免命令的守卫顺序、目录创建行为均不变。
- **带值选项的「短选项紧贴值」形式被三套解析器区别对待**。`-u30000` 这类 token 此前在 `assertKnownFlags`（前缀放行）、`parseIntArg`（后缀非纯数字时静默回退默认值）、`extractStartOptions`（整个 token 静默丢弃）三处各有各的判定，后果全是「不报错但行为不对」：

  - `mihomo start -u5s`：白名单放行、解析器吞掉，一路走到「未找到内核」才炸；而空格形式 `logs -n 5s` 正确报错——`parseIntArg` 自己的注释就写着「宁可报错也不给用户一个看似成功的错误结果」
  - `logs -n5s`：静默回退默认行数后落进列表分支，打印「暂无日志」
  - `mihomo sub use foo -u30000`：白名单放行、重启透传却丢掉选项，重启走默认 10s 超时——正是 `flags.ts` 文件头宣称已结构性消灭的「`sub use foo -s` 丢选项」形态

  「这个 token 是不是带值选项的某种形式（exact / attached-short / long-eq，属于哪个 spec）」收成 `flags.ts` 的 `matchValueFlagToken`，三套解析共用一个判定：attached 后缀非纯数字走与空格形式同一条报错路径；attached 是自包含 token，透传整个 token、不吞下一个；白名单的非 exact 形式额外要求基础形式在该命令的白名单内（`logs` 认 `-n200` 但不认 `-u30000`，按命令隔离而非全局放行）。`-u=3000`（短选项带等号）明确报错而非支持：等号形式只认长选项，后缀 `=3000` 非纯整数，不留「白名单接受但解析器吞掉」的空洞。`log.ts` 的 `hasLinesFlag` 是同一判据的第四份本地拷贝，一并改走登记表。
- **热重载成功后不复读停止计数，并发的 stop 被 start 报成「已启动」**。v4.8.0 给 kickstart 路径补「健康确认失败后复读计数」时只铺了失败分支：`tryHotReload` 从状态探测到 PUT 返回最坏二十多秒（两次 launchctl 查询、/version、lsof、PUT 各带 5s 超时），期间并发的 stop 已完成 bootout+disable+递增——内核确实吃进了新配置但随即被停掉，`restartService` 却照常返回成功。现在热重载成功先经 `concludeHotReload`（纯函数，判据复用唯一那份 `shouldAbortStartOnDisable`）复读计数再下结论，变了就走 `launchOrRestart` 既有的「启动已取消」出口，文案不另起一份
- **stop/uninstall 锁内临界区最坏 15s，超出锁的 10s 强夺阈值**。锁体含三次 launchctl（bootout、disable、print-disabled 复核），默认单次 5s——launchctl 慢时并发的 start 会在 10s 判锁陈旧强夺进入，两进程同处临界区，epoch 判据被整体绕过。曾评估把调用缩到两次（复核挪锁外/调顺序），但三个环节谁也挪不出锁：复核必须先于递增（位没生效不能记「停止过」）、递增必须在锁内（否则并发 start 滑进 disable 与递增之间，判据检不出）、bootout 必须与 disable 同锁（否则 start 的 bootstrap 滑进两者之间，KeepAlive 把杀掉的内核拉回）。改为锁内单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s < 10s）：三次都是本机 XPC 往返（print 实测 3ms），唯一会阻塞数秒的 kickstart -k 本就刻意留在锁外；launchctl 慢到 3s 不够说明系统已病态，快速失败好过持锁超时拆掉并发防线

### 验证

- 新增 `commands/subscription.spec`（13 条）：四个子命令各拒外来选项，断言退出码、错误信息与该子命令自己的用法/可用选项提示，并核对 settings 未被改动；use 的 `-s` 与 `-u <ms>` 空格形式、remove 的 `-y`（含写在名称之前、非交互下跳过模糊匹配确认）走真实 CLI 断言最终数据状态；分发回归（裸 sub 列表、未知子命令、子命令位置的选项、未知 flag）。选项用空格形式，紧贴值形式的解析由另一分支统一处理
- 新增 `service-concurrency.spec`：PATH 前置桩 launchctl + 桩 controller 驱动真实模块（真实 launchd 零接触、无永久记录）——热重载成功后计数已变则报「启动已取消」；stop 锁内慢 launchctl 的实测持锁时长断言低于 `LOCK_STALE_MS`（反向验证：还原 5s 超时实测持锁约 12s 超阈值，原缺陷复现）。paths.spec 三进程编排锁死「双等待者临界区不重叠」（反向验证：还原无条件 rmSync 以正确原因转红）；log-files.spec 双进程同时轮转恰一份归档（反向验证：换回 existsSync-then-rename 两次运行稳定复现覆盖）；runtime.spec 真实桩内核端到端锁死 TUN 模式判据
- **不变量测试**：遍历 `FLAGS` 登记表，对每个带值选项的 exact / attached / 等号三种形式断言「白名单接受 ⟹ `parseIntArg` 解析出正确值（不静默回退默认）」，`START_RESTART_FLAGS` 成员另断言三种形式重启透传都不丢、attached 不吞下一个 token——任何人改三套解析器之一破坏一致性，当场转红
- **反向验证过**：把 `extractStartOptions` 临时改回丢弃 attached 形式，不变量用例与回归用例精确转红（`-u：三种形式重启透传都不丢`、`attached 短选项整体透传`），恢复后全绿
- `parseIntArg` 逐例锁定：`-u30000` 解析 30000；`-u5s` / `-u=3000` / `-n5s` / `-nfoo` 走同一报错路径；白名单负向：未知 attached（`-z5`）与跨命令形式（`logs` 的 `-u30000`）仍拒绝，布尔 attached（`-sx`）不透传
- `concludeHotReload` 收口成纯函数后锁行为语义（计数未变频照常成功、基线非 0 时又 stop 必须检出、epoch 回退同样视为变更、被取消时 hotReloaded 如实为 true）
- 新增 `service-concurrency.spec`：PATH 前置桩 launchctl + 子进程跑真实模块（launchd 一点不被碰，enable/disable 不留永久记录）。热重载场景配桩 controller（/version 自报 mihomo、PUT 返回 204，PUT 到达那一刻用真实 `recordServiceStopped` 递增计数）端到端验证 `launchOrRestart` 的用户可见后果，含无并发停止的负向对照；stop 场景测锁文件出现到消失的持锁时长，慢而成功（三次各 2.5s）与超预算（4s）两个形态都断言低于 `LOCK_STALE_MS`（经 paths.ts 导出的真实常量）
- **反向验证过**：撤掉热重载复读、或把 stop 锁内超时还原为默认 5s，各恰好一条对应用例转红（后者实测持锁约 12s 超阈值，即原缺陷复现）

## [4.8.1] - 2026-09-12

用户实测：同机场两条订阅只有一条有某个分组，覆写补丁把另一条的配置搞成内核拒绝加载。新增 `~?key` 表达「只改已有、不新增」，并补上「报错指不出覆写」的可诊断性缺口。单测 340（+15）。

### 新增

- **`~?key`：按 `name` 就地合并，匹配不到同名元素就跳过**。`~key` 的「未命中则追加」是有意设计，ssh 出口那类用法靠它新增节点，不能改；但同一个语法还承担着另一种意图——「订阅下发了这个分组我才改它」，补丁往往只带 `name` 和一两个要改的字段。这两种意图方向相反，此前挤在一个操作符里。

  实测现场：同一机场的两条订阅 URL 同域名，覆写按 `url-domain` 对两条都生效，其中精简套餐没有 `Developer` 分组，于是 `~proxy-groups: [{name: Developer, default-selected: TW Fixed IP}]` 被追加成一个**只有 name 和 default-selected、缺 `type`** 的分组，mihomo 报 `ProxyGroup Developer: '' has unset fields: type` 并拒绝加载整份配置——切到这条订阅就再也起不来。

  改用 `~?proxy-groups` 后，**作用域一个字不用改**：有该分组的订阅照常合并，没有的自动跳过。被跳过时打印一行提示（「已跳过」+ 补丁名 + 来源文件），因为静默跳过与「分组名拼错」在用户眼里完全一样。解析放在剥掉 `~` 之后判断，真以 `?` 开头的键名仍可用 `<~?key>` 转义。

  **为什么不改 `~key` 自身的行为**：README 明确承诺「找不到则追加」，ssh 出口章节的 `~proxies` 示例依赖它，三条既有测试锁着它。**也不按「补丁是否带 type」自动推断意图**——那是猜，而分组必填字段随内核版本漂移，猜错的方向是静默丢掉用户的配置。让用户显式表达意图更可靠。

### 修复

- **内核报错指不出「这个键是覆写加进来的」**：用户能看到的只有 `ProxyGroup Developer: '' has unset fields: type` 这一行，看不出这个分组是覆写追加的。现在校验失败时附上本次实际生效的覆写文件与作用域（已按 `ow` 开关与 `match` 过滤），并提示可改用 `~?key`。清单为空时不加该段（问题就在订阅本身，多打一段只会把方向引偏）；超时分支同样不加（与配置内容无关）。

  **教训**：这类问题的本质是**错误信息缺少产生它的上下文**，而不是校验不够严——继续在 CLI 里加字段校验只会与内核重复一份必然漂移的规则，把上下文补回去、再给用户一个表达意图的语法，才是对的方向。

- **doctor 把失败项的 hint 整个丢掉**：`cmdDoctor` 只取 `message.split('\n')[0]`，于是配置校验失败时连内核原文都不显示，只剩一句「内核拒绝加载配置」。`Check` 加 `notes` 字段透传 `CliError.hint`，否则上面那条改进在 `doctor` 里完全不可见。

### 测试

- `~?key` 四条行为用例：命中时与 `~key` 一致、未命中跳过且记录、目标键整体不存在时也跳过（不凭空造数组）、`~key` 未命中仍追加（锁住 ssh 场景不受影响）；另加 `<~?key>` 转义与解析用例
- 端到端两条走 `buildConfig`：未命中时订阅原有分组不受影响且 `warnings` 含补丁名与来源文件、命中时正常合并且不告警
- **反向验证过**：把 `~?` 的跳过分支短路成「照常追加」，精确只有三条 `~?` 用例失败，`~key` 的既有语义（含 ssh 追加）全部照过
- 文案收口成纯函数 `buildKernelRejectHint` 后逐行锁定（目标形态、空清单不加该段、多行内核输出的缩进、覆写摘要经终端消毒）
- `buildConfig` 带出的覆写清单按作用域过滤：把真实事故现场（同域名两条订阅 + `url-domain` 限定）写成回归用例
- 用户真实数据实测：`overwrite.glados.yaml` 保持 `url-domain` 作用域不变、仅把 `~` 换成 `~?`，mini1 通过内核校验且不含残缺分组，edu1 的 `default-selected: TW Fixed IP` 照常注入

### 变更

- README 的覆写示例改用 `~?proxy-groups` 并保留 `url-domain` 作用域：此前建议「收窄 match 避险」，但那是让用户改作用域去绕开语法缺陷，方向不对

## [4.8.0] - 2026-09-12

清掉 `CODE_REVIEW` 挂着的三条服务并发缺陷（并顺着同族形态又找出三处），补齐三处用户侧缺口，并把发布可追溯性补上——此前 78 个 npm 版本一个 tag 都没有。单测 325（+24）。

### 新增

- **`mihomo config [--json]`**：查看当前生效的运行配置。**重新推导而非读 `runtime/config.yaml`**——那个文件在 `stop` 时被 `clearRuntime()` 整个删掉，而「停着的时候看看配置对不对」恰是最需要它的场景；改完订阅或覆写想确认结果，也不必先把服务跑起来。推导走 `buildConfig`（与 `start` 同一条路径，故看到的就是启动会写进去的内容），刻意不调 `prepareConfigForStart`——那会执行内核原生校验，而这是只读展示命令，校验归 `doctor` 和 `start`。`secret` 脱敏后展示。
- **`mihomo completion uninstall <shell>`**：补全此前只能装、不能卸。bash 写的是共享文件 `~/.bash_completion`，故只剥掉自己的标记块、保留用户自己的补全（文件因此变空则一并删掉，避免装卸往返留下空文件）；zsh/fish 独占文件名可以整个删，但**删之前先确认那是本工具生成的**（按脚本特征串判断），否则报错并给出手动路径——误删用户自己写的同名补全比留个孤儿文件糟得多。
- **Node 版本运行时守卫**：`package.json` 的 `engines` 只让 npm 打一行 warn 就装上了，之后炸在某个语法或 API 上，报错与真实原因（Node 太旧）毫无表面关联。下限从 `engines.node` 读（单一来源，不另写常量），与平台/root 守卫同族、同一份豁免名单（`help`/`version` 必须能跑，否则用户连「装的是哪个版本」都问不出来），并同样排在 `ensureDirs` 之前——否则旧 Node 上会先建出一套数据目录再报错。

### 文档

- 补上彻底卸载的**顺序**陷阱：先 `npm uninstall -g` 会留下带 `KeepAlive` 的 LaunchAgent plist 与已装的补全，而能清理它们的命令已经没了。给出反了之后的手动补救步骤（已逐条核对 label、域与路径）。

### 仓库

- **补录 78 个历史 tag**：此前仓库一个 tag 都没有，78 个 npm 版本无法定位源码，CHANGELOG 的记录也指不到代码。落点取「该版本号在 package.json 中存活、且提交时间不晚于 npm publish 时刻」的最后一个提交——直接取「该版本最后一个提交」会让 10 个 tag 指向发布之后才写的代码。规则唯一确定 74 个，4 个早期版本（先发后推，提交晚于 publish 2–7 分钟）回退取首个提交并在 tag message 注明；`1.5.2` 已被 unpublish，不打。
- 为 v4.x 建 19 个 GitHub Release，正文取自 CHANGELOG 对应小节；v4.2.2 当时未留记录，改用提交主题成文并标注该缺口。
- 新增 `SECURITY.md`（支持范围、私密上报渠道，以及内核下载校验、controller 鉴权、订阅凭据存放、提权范围这几条信任边界的实际实现）与 dependabot 配置（npm + github-actions，weekly）。
- 修掉 `package-lock.json` 长期停留在 4.7.1 的版本号漂移。

### 修复

- **并发的停止在六条路径上仍会被覆盖或被误报**。v4.7.7 把并发判据换成停止计数后，`CODE_REVIEW` 里挂着三条静态发现的残留缺口；本轮逐条修掉，并顺着同一族形态又找出三处。共同签名是**递增点与消费点没有成对枚举**——收口的对象是判据，不是调用点。

  「停止被静默覆盖」类（终态与用户最后一条命令相反，而两个终端都拿到成功回执）：

  - **`stop` 的两条提前返回一次都不记账**。「不在运行」（未装载、且未安装或已 disabled、无内核进程）与「只杀游离内核」都成功返回却不碰 `disableServiceAutoStart`，于是对并发的 `start` 完全隐形。前者的前置恰是最常见的组合：上次 `stop`/`tun` 留下 disable 位，A 正在 `start` 的慢速阶段（订阅更新约 10s），B 此时 `stop` 走的就是这条。
  - **`reset` 在服务未装时删掉运行前提也不记账**。`reset logs/runtime/kernel/subs` 在 `serviceActive` 为假时不走 `stopService`，却已经把 `runtime/config.yaml` 或 `kernel/` 删掉——并发的 `start` 随后 bootstrap 一个内核已被删除的 plist，落进 KeepAlive 每约 10s 拉起一次的崩溃循环。
  - **`restartService` 的回退启动没有防线**。`kickstart -k` 失败后回退 `enable` + `bootstrap`，与 `startService` 是同一动作却少了同一道判据，而热重载探测加 kickstart 最长可达 60s。
  - **`installService` 的恢复分支快照取得太晚**。取在 `bootoutService()` + `waitUntilUnloaded()`（最多 5s）之后。更关键的是 `stopService` **在自己的锁内先递增、之后才等卸载**，所以存在「B 已递增而 `launchctl print` 仍报 running」的区间：`cmdInstall` 会合理地读到 `wasRunning=true`，而在 bootout 之后现取的快照必然已经 ≥ B 的值，并发就此隐形。快照改由命令层传入。

  「把用户自己的停止报成内核故障」类（终态正确，但报错指向完全错误的排查方向）：

  - **bootstrap 成功到健康确认结束的 1.2–3s 完全在锁外**（`SERVICE_OBSERVE_MS` + GRACE），v4.7.7 的防线只覆盖了锁内那一瞬。这段窗口在**最常走的 `mihomo start` 路径上**，且比上面几条都长：期间的 `stop` 把任务 bootout，`waitServiceHealthy` 于是走 `!loaded` 分支，用户拿到「内核未能进入运行状态」加一段与问题无关的日志尾部。`cmdInstall` 的恢复运行确认有同样的暴露，此前会报「恢复运行失败」。两处都改为失败后复读计数再下结论。
  - **取消文案本来就不实**：递增点不止 `stop`，`tun` 与 install 首装同样会关闭自启并递增，而文案写死「另一个终端执行了 mihomo stop」——说的是一件没发生的事。改为「检测到停止操作」并说明哪些命令会关闭自启。

  判据仍是唯一那份 `shouldAbortStartOnDisable`，本轮只增加消费点、不新增判据。不变式不是放宽而是承认第二种同等强度的证据：递增只发生在「已确认不会自启且无内核在跑」之后，证据可以是复核过的 `disable`，也可以是刚读到的状态本身（这些读取失败时都抛错而非降级，故「走到了这条路径」本身就是独立依据）；因此调用点必须放在该路径**最后一道失败检查之后**——抢在前面就会让一次失败的停止把并发的 `start` 白白中止。新入口取名 `recordServiceStopped` 而非 `…Intent`：叫「意图」会引来「那就在 `cmdStop` 开头记一次」的改法，那正是要防的。

  `launchOrRestart` 的 `stopEpochBefore` 由可选改为必填：可选默认值会让新调用方静默退化成「只防本函数执行期间的 stop」，而这正是本轮六条缺陷的共同形态。

### 变更

- 删除 quickstart.sh，只维护 TypeScript CLI 的下载、配置和启动流程
- 配置语义交给已安装的 mihomo `-t` 校验，通过后才替换运行配置；删除 CLI 中自动删节点、分组、规则和注入 exclude-filter 的逻辑，错误配置需显式修正
- 不再生成三份分阶段调试 YAML，只保留最终 config.yaml，校验临时文件用后清理
- 简化 reset 为明确执行阶段，删除回调与目标顺序约束；部分覆写重置恢复默认开启，删除失败报错，内核不存在时仍清理下载残留
- 移除 settings 进程缓存，保留原子写与持锁读改写，空补丁不创建或重写文件
- 删除 daemon/up/down 墓碑、log 过渡别名、reset daemon 及旧选项专用迁移分支；未知输入统一报错，布尔开关拒绝附带值
- 删除未使用的配置中间类型与状态字段；status JSON 的 ports 仅保留 mixed/tun
- 保留必要的 root 服务清理、launchd 健康确认与文件锁；同步精简开发文档和发布流程中的旧实现说明
- README 的覆写示例不再把 `subscription` 与 `url-domain` 说成可互换：同机场多条订阅 URL 同域名，用 `url-domain` 会一并命中，正是上面那条缺陷的诱因

### 测试

- 更新配置、设置并发与 reset 的行为测试；reset 测试同时隔离数据目录和服务 label
- 用 mihomo v1.19.30 验证 Mixed/TUN 配置以及重名节点、缺失引用等拒绝场景，确认失败保留原有运行配置
- 单测 325（+24）。新增 `commands/stop.spec`：隔离数据目录加不存在的服务 label 天然走「不在运行」分支，一次 launchctl 写操作都不做，故这条能自动化；断言消费者可见的后果而非计数文件内容，并含负向对照（`status` 不得改变计数）。游离内核用真实桩进程验证，判活以 `ps` 状态列为准而非 `kill -0`（僵尸进程会骗过它）
- 新增 `commands/node-guard.spec`（伪造 `process.versions.node` 而非真装旧 Node——真旧 Node 连 tsx 都未必起得来，反而测不到守卫）、`commands/completion-install.spec`（把 `HOME` 指向临时目录跑真实装卸，断言文件最终内容：用户自有内容完好、标记块消失、非本工具产物拒绝删除）、`commands/config.spec`（全部在没有 `runtime/config.yaml` 的目录里跑，锁住「重新推导」这一性质；输出用 js-yaml 实际解析，确认是合法 YAML 且 secret 已脱敏）
- 三种 shell 的补全脚本经 `zsh -n` / `bash -n` 语法校验；fish 未装，其脚本未做语法校验
- 复核测试有效性：临时注掉两处 `recordServiceStopped`，两条用例即转红
- install 恢复与 restart 回退的并发交错仍只能手工双终端复现（需真装内核的机器），已记入 `CODE_REVIEW` 的未覆盖项，未假称已自动化

## [4.7.7] - 2026-09-07

收尾 v4.7.6 修复留下的残留缺口：并发判据换成停止计数，与 launchd 的 disable 位解耦。单测 319（+5）。

### 修复

- **并发的 `stop` 在「上次也 stop 过」时会被 `start` 覆盖**：v4.7.6 把判据从「当前是否 disabled」改成「disable 位的前后快照比对」，修好了「stop 之后 start 永远起不来」，但留了个反向的洞——**两边快照都是 `true` 时判为「非并发」**。可达序列：A 跑慢速 start（上次 stop 过，故快照 `disabledBefore=true`）→ B 在订阅更新那约 10s 里跑完整个 `mihomo stop` → A 锁内查到仍是 `true` → 判为「无人 stop」→ enable + bootstrap，把 B 的 stop 覆盖掉。用户最后一条命令是 stop，终态却是运行中，而两个终端都拿到了成功回执。

  根因是 **launchd 只提供 disable 位的当前值，给不出「它是何时被写的」**——任何基于位的判据都区分不了「上次留下的」与「刚刚新置的」。改用 CLI 自己维护的单调计数（`~/.mihomo-cli/service-stop-epoch`）：`start` 在慢速阶段之前取快照、锁内复读，值变了就说明期间有人 stop 过，与位的当前值完全解耦。递增**收口在 `disableServiceAutoStart` 内**（五个调用点，任一漏 bump 就是那条路径上的防线空洞），并放在「位已确认生效」之后——位没生效就记「停止过」，会让并发的 start 白白中止。

  同族路径 `installService` 的 `wasRunning` 恢复分支共用该判据（它同样在锁内 enable+bootstrap，同样会反噬并发 stop），被取消时返回 `restoreSkipped: true`，`cmdInstall` 据此跳过健康确认并单独提示——否则会把用户自己的 stop 报成「恢复运行失败」。

  `bootout` 刻意仍留在锁外：`withFileLock` 要求 fn 同步（持锁期间 await 会让另一进程等到强夺陈旧锁），而 bootout 后必须 `waitUntilUnloaded`（最多 5s）。这是安全的——并发 stop 落在该窗口时，start 侧的 bootout 只是幂等空操作，计数变化仍会在锁内被检出。这正是计数判据相对「扩大临界区」的价值。

  **教训**：这个判据两版都错在同一件事上——拿一个**状态**去推断一个**事件**。disable 位是状态，「有没有人 stop 过」是事件；状态没有历史，事件才有。发现自己在用「读一下当前值」回答「期间发生过什么」时，就该换判据而不是换比较方式。

### 测试

- `shouldAbortStartOnDisable` 五条组合（含 v4.7.6 漏掉的「基线非 0 且期间又 stop」）+ 三条走**真实** `readStopEpoch` 的用例（经 `MIHOMO_CLI_DIR` 指向 tmpdir，不碰 launchctl 故系统无痕迹）。测试调的是 `service.ts` 导出的实现而非另抄一份——抄一份等于在验副本
- `paths.spec.ts` 补一条：停止计数文件同样不能落在会被 `rmrf` 的目录（它命名刻意不带 `Lock` 后缀，不进锁枚举，故单独点名）。被删后读作 0，「期间发生过 stop」的记录就丢了
- **反向验证过**：v4.7.6 的判据在「基线非 0 且期间又 stop」下返回 `false`（放行 → 覆盖并发 stop），计数判据返回 `true`。另跑四场景端到端脚本，两代缺陷各自的失效点都覆盖到

## [4.7.6] - 2026-09-07

用户实测报告的单点修复：`mihomo stop` 或 `mihomo tun` 之后，`mihomo start` **再也起不来**。单测 314（+4）。

### 修复

- **`start` 被 `stop`/`tun` 留下的持久 disable 位永久卡死**：v4.7.5 给 `startService` 加的并发防线判据用错了——锁内查到 disabled 就直接 return，既不 `enable` 也不 `bootstrap`。但 disable 位有**两种来源，语义完全相反**：一种是上次 `stop`/`tun` 留下的**持久**状态（该位存在 plist 之外，launchctl 没有清除动词，会一直躺着直到被 `enable`），另一种才是「本次执行**期间**另一终端跑了 `stop`」这个真正要防的并发。单次采样把两者抹平，于是前者被当成后者：`stop`/`tun` 之后的**每一次** `start` 都静默什么都不做，内核永不被 launchd 拉起，唯一出路是用户手动 `launchctl enable`。

  失效面全是误导：报错是「启动失败: 内核未能进入运行状态」（走的是非 crashed 分支），附的日志路径**从未被创建过**——用户据此以为是配置或内核的问题，手动直跑同参数的内核却一切正常；而 CLI 自己的文案还在承诺「TUN 用完后 `mihomo start` 可恢复」「`stop` 后 `mihomo start` 可恢复服务」。

  修法是**收窄判据而非删掉防线**（直接删能修好现象，但会把并发保护一起删了）：判据收口为纯函数 `shouldAbortStartOnDisable(disabledBefore, disabledNow)`，只有「期间新出现」才算并发 stop。快照取自 `cmdStart` 开头（订阅自动更新等慢速阶段**之前**）已有的 `getServiceStatus()`，经 `launchOrRestart` 透传——在 `startService` 内部现取会退化回原缺陷。另把并发取消单独成一条错误（「启动已取消：期间检测到 stop」），此前它也落进 `assertServiceHealthy`，意味着真并发场景同样会看到那句指错方向的「内核未能进入运行状态」。

  顺带修掉 `uninstallService` 头注释里已失效的一句（「`startService` 恒无条件 `enable`」——v4.7.5 起就不成立，这处自相矛盾正好佐证了防线与原设计意图冲突）。

  **教训**：给并发场景加防线时要问一句「这个信号除了并发，还有没有别的来源」。disable 位的两种来源语义相反，而「查一下当前是否 disabled」这个看似自然的判据把它们抹平了。

### 测试

- `shouldAbortStartOnDisable` 四条组合全锁（`service.spec.ts`）。**反向验证过**：把判据改回旧实现后，精确只有「开始前就存在 → 必须照常启动」这条失败，其余三条仍过——说明测试锁的是缺陷本身，不是顺带的行为
- launchd 语义用一次性 label + 桩内核真机实测（验完即 `bootout`，无残留）：确认 disabled 下 `bootstrap` 是**硬失败** `Bootstrap failed: 5: Input/output error`（故只删 early-return 而不 `enable` 会换一种方式失败），`enable` → `bootstrap` 后 `state = running` 并拿到真实 pid

## [4.7.5] - 2026-09-06

第二轮独立复审，聚焦**同族缺口**：三处缺陷有共同模式——防线或测试断言只铺了一条路径，同族的另一条躺在盲区里。另清理三处过度设计。单测 310（+20）。

### 修复

- **`cache.json` 的锁位于会被 `rmrf` 的目录，跨进程互斥可被打破**（v4.7.4 的同族漏网）：上一版把 `service.lock` 移出 `runtime/`，但根因不在锁的位置——`withFileLock` 旧签名收**被保护的数据文件**、内部拼 `${filePath}.lock`，于是锁的位置被数据文件的位置**绑死**。`cache.json` 住在 `subscriptions/` 里，锁也就在那儿，`reset subs`（含裸 `reset`、`reset --full`）的 `rmrf(DIRS.subscriptions)` 照样把别人正持着的锁连目录带走 → 第三个进程立刻 `openSync(..., 'wx')` 成功，两进程同时进临界区（已实测复现）。可达路径：慢速 `sub update` 并行下载、逐条回写缓存期间，另一终端跑 `reset`。签名改为收**锁文件本身**，三把锁（`settingsLock`/`subscriptionCacheLock`/`serviceLock`）成为 `PATHS` 里的显式常量、一律在 `USER_DATA_DIR` 根下。**教训**：v4.7.4 的断言只点名 `PATHS.serviceLock`，所以这个缺口测试测不出来——防线铺在一条路径上，测试也只守那一条，同族缺陷必然漏网
- **带序号的归档日志永远不出现在 `logs` 列表里**：`cleanupOldLogs` 与 `listLogs` 各写一份正则，只有前者认序号后缀 `mihomo.<时间戳>.N.log`——那些归档会被按时清理（不堆积）却列不出来，`logs <编号>` 永远访问不到（已实测：造两个同秒归档，带序号那个不出现）。而序号后缀恰恰产生于「同一秒内二次轮转」，也就是 **start 失败后立即重试**这个最需要翻日志的场景。判据收口成 `isArchiveLogFilename` 一份，清理与列表共用
- **`reset` 重建刚删掉的 `settings.json`，并把覆写静默关掉**：`overwrites` 的 `onAfter` 调 `writeSettings({overwrite_enabled: false})`，却排在 `settings` **之后**——`reset --full` 报「已重置: 设置」而磁盘上留着 `{"overwrite_enabled": false}`（已实测复现）。伤害不止于谎报：全新数据目录的覆写默认是**启用**，于是用户重置后重新放一份 `overwrite.yaml`，覆写静默不生效，且完全看不出与上次 reset 有关。`reset.spec.ts` 此前只点名断言了 `subs`（同族的另一个写 settings 的目标），`overwrites` 因此漏网——又是同一个模式

### 变更

- **删掉 `parseYamlOrJson` 的 JSON 回退分支**（更名 `parseConfigContent`）：YAML 1.2 是 JSON 超集，实测标准 JSON、tab 缩进 JSON、长整数全部由 YAML 解析器正常收下。唯一能走到 `JSON.parse` 的输入是**重复键 JSON**（YAML 明确报错，`JSON.parse` 静默取最后一个值）——那条回退把「坏数据」变成了「静默接受」，方向正好相反。现只走 YAML，并把解析器的行列号带进错误消息（`订阅内容格式错误，无法解析: duplicated mapping key (1:9)`）
- **三份镜像清单收成一份**：`AVAILABLE_MIRRORS`（展示，手写域名）、`MIRROR_ALIASES`（解析，手写地址）、`getDefaultMirror` 里硬编码的裸域，增删镜像要改三处且无机制兜底——漏改展示清单只是文案过期，漏改别名表则是**别名直接不认**。现全部从 `MIRROR_HOST` + `MIRROR_ALIASES` 派生（派生结果与改动前逐项一致，对外行为不变）
- **`openUrl` 改为无返回值**：`open` 是 detached spawn，失败（ENOENT、目标不存在）全发生在函数返回**之后**，只能被 `child.on('error')` 吞掉——故它**恒返回 true**，四个调用点的 `if (!success) 请手动打开…` 全是死代码，反而让人误以为失败真能被检出。调用方改为一律无条件打印地址/路径（`dir open` 顺带把路径也打出来了，此前只有标签）。要真检出失败得换 `spawnSync` + 解析退出码，为一个非阻塞的顺手操作引入同步等待不划算——**这是刻意选择不检出**

### 安全

- **`quickstart.sh` 补齐 `asset.size` 比对与 `--max-filesize`**：这两道 CLI 侧早就有的防线在脚本里缺着，是**第三次**被人肉发现的平行实现漂移（前两次是安全水位、资产选择形态）。已用真实下载验证：16.8MB 内核 size 精确匹配、上限不误伤正常路径；反向压到 1MB 时 curl 拦下且文件不落盘。脚本侧的 size 依赖 jq（取不到即留空跳过比对，不阻断下载），属能力差异而非水位差异

### 测试

- **锁位置断言泛化**：从点名 `PATHS.serviceLock` 改为按 `xxxLock` 命名约定枚举 `PATHS` 的**全部**锁，新增锁只要照此命名就自动进回归测试；另加一条「枚举到的锁数量 ≥ 3」的断言，防命名约定被破坏后上面那条空转成永真。再加一条真跑 `rmrf(DIRS.subscriptions)` 验证缓存锁幸存的用例
- **reset 顺序约束按清单遍历**：受约束目标登记进 `WRITES_SETTINGS_ON_AFTER` 具名常量，测试遍历它而非点名单个目标。另加两条**端到端**断言（真跑 `reset --full` 后查磁盘上的 `settings.json` 与 `isOverwriteEnabled()`），它们**不依赖清单的正确性**——清单漏登记时顺序断言会空过，端到端断言仍会失败
- 新增 `log-files.spec.ts`（归档名判据 5 例，含带序号、路径成分混入等）、`parseConfigContent` 用例（7 例，锁住「JSON 输入仍能解析」防有人把回退加回来）、镜像清单派生关系用例（4 例）
- 三处缺陷的新断言均**反向验证过**：在修复前的实现上会失败（reset 那三条是拿上一版的 `reset.ts` 跑，全部报错）

## [4.7.4] - 2026-09-06

独立复审一轮，聚焦「上轮文档未覆盖」的缺口。两处并发/可见性缺陷均已实测复现后修复。单测 290（+7）。

### 修复

- **`start`/`install` 报「退出码 null」，信号死亡的死因在启动路径上不可见**：v4.7.3 补信号判据时把 status/doctor 的重复判断收口成 `describeAbnormalExit`，**却漏了 `runtime.assertServiceHealthy` 这第三个消费者**——它仍自己拼 `退出码 ${exitCode}`，而信号死亡时 launchd 不写 `last exit code`（整行消失，本轮用一次性 label + 桩内核再次实测确认），于是 `start` 期间被 OOM killer 杀掉的内核只显示「内核启动后立即退出（退出码 null）」，`ServiceHealth.terminatingSignal` 一路传过来却无人读。判据现收口成 `describeExitCause(exitCode, signal)` **一份**，三个消费者共用（`isCrashed` 判有无、`describeAbnormalExit` 供 status/doctor、`assertServiceHealthy` 供 start/install），修复后文案为「被信号终止（Killed: 9）」。**教训**：把实测事实锚在注释里挡不住漏铺——注释锚在事实发生处，防线要铺在所有消费处，两者不重合时只有「判据收成一个函数」才真的有效
- **`service.lock` 放在会被整体删除的 `runtime/` 下，跨进程互斥可被打破**：`stop()` 的 `clearRuntime()` 与 `reset runtime` 都会 `rmrf(DIRS.runtime)`，把**别的进程正持着的锁文件**一起删掉——第三个进程随即 `openSync(..., 'wx')` 成功，两个进程同时进入临界区（已实测复现）。`withFileLock` 的 token 所有权校验对此无效：它防的是「被强夺者误删新持有者的锁」，而这里锁是被第三方连目录一起删的，持锁方毫不知情。可达路径正是文档反复强调的那个——慢速 `start`（订阅更新约 10s）持锁期间另一终端 `stop`，后果是自启位终态与用户最后一条命令相反。锁现移到 `USER_DATA_DIR` 根下

### 测试

- 新增 `describeExitCause` 判据本身的用例（5 例），含「不能退化成只看退出码」的锁定断言——直接对判据断言而非各消费者，避免再出现「收口了却漏一个消费者」
- 新增锁存放位置的用例（2 例）：断言的是**不变量**「`service.lock` 不在任何会被 `rmrf` 的目录下」而非具体路径（后者会在目录结构调整时误报），另一例记录缺陷机制本身。已验证该测试对旧位置确实失败

### 变更

- **`CLAUDE.md` 修正一处写反的记载**：「内核下载的来源信任」的 quickstart.sh 对照表里写「无标准版资产时回退第一个匹配项（CLI 不回退）」，但 `kernel.ts` 是 `standardAsset || matchingAssets[0]`，且 `kernel.spec.ts` 有单测锁定回退行为——两侧其实一致，是文档写反了。这段文字的用途正是两侧对齐的对照表，写反会误导下次对齐。顺带指明真正不回退的是 `pickLatestRelease`（全预发布时抛错）
- **`CLAUDE.md` 新增两条纪律**：锁文件不能放在会被 `rmrf` 的目录里（附受影响目录清单）；异常退出判据只有 `describeExitCause` 一份，别散写 `lastExitCode !== 0` 也别自己拼退出码文案
- 去掉 4 处对同步函数（`bootoutService` / `withFileLock`）的 `await`——`withFileLock` 明确要求 `fn` 同步（持锁期间让出事件循环等于没锁），`await` 会暗示可传 async mutator
- README 同步两处：`start` 失败报错会写明死因（与 `status` 同口径）；数据目录树补上 `service.lock` 并注明为何放在根下

## [4.7.3] - 2026-09-06

清掉 CODE_REVIEW 积压的全部未处理项（一条修复、一条决策豁免）。单测 283（+37）。

### 修复

- **TUN 模式下 `dns.enable: false` 生成自相矛盾的配置**：订阅/覆写显式关闭 DNS 时，生成的配置一边写 `dns: {enable: false}`、一边保留 `tun.dns-hijack: [any:53, tcp://any:53]`，还往已关闭的 dns 块里补注 fake-ip 字段。TUN 劫持 53 端口而内置 DNS 关着，没有任何组件接管，网络直接不可用。现把 `dns.enable` 视为 TUN 下的系统锁定项（与 `external-controller`/`mixed-port` 同一性质）强制为 `true` 并给出告警。不选「拒绝启动」是因为该值常由机场下发、用户改不了，硬拒绝等于逼用户先学会写覆写文件才能用 TUN；**只锁 `enable` 一个键**，`nameserver`/`enhanced-mode` 等仍尊重用户配置
- **信号死亡的内核对 `status`/`doctor` 完全不可见**：被 OOM killer 或 `kill -9` 干掉时，launchd 只写 `last terminating signal = Killed: 9`，`last exit code` 整行消失（实测 macOS 26.6，两字段互斥）——而解析器只读退出码，于是用户看到「不在运行」却没有任何异常提示，实际 KeepAlive 正每隔约 10s 反复拉起。现 `parseServicePrint` 解析该字段，崩溃判据两者取一。顺带把 status/doctor 里三处重复的「上次异常退出」判断收口成 `describeAbnormalExit`——此前补一条判据要同步改三处
- **`dns` 形态校验只有 TUN 一条路径有**：mixed 下 `dns: true` 一类订阅笔误照样抛裸 `TypeError` + 堆栈，被当成程序 bug。校验下沉为 `assertDnsShape`，两条路径共用
- **全是预发布版时 `pickLatestRelease` 回退首个 release**：会把 alpha 当稳定版装上。今日不可达（上游同时只挂一条 alpha），但内核以 root 身份跑（TUN）或长期常驻，静默降级到未发布版本不可接受，现直接抛错

### 测试

- **新增 `process-stop.spec.ts`（12 例）**：真起桩进程、真 `pkill`，覆盖 `cleanupAll` 的单杀/批量（>3）分支、符号链与真实二进制两种命令行形态、`stop` 的 notRunning 语义、`isRunning` 的 PID 复用防线。无侵入——`MIHOMO_CLI_DIR` 指向 tmpdir 后 `MAIN_INSTANCE_PATTERN` 内嵌的绝对路径使其物理上不可能匹配到用户真在跑的内核，**该前提本身有一条用例断言着**（pattern 若改成不含绝对路径，测试当场失败而非静默扩大杀伤范围）
- 新增 `config-dns.spec.ts`（15 例）锁定 TUN dns 锁定语义与两条路径的形态校验；`service.spec.ts` 补信号死亡的真实 launchctl 输出 fixture 与 `describeAbnormalExit`

### 变更

- **`CODE_REVIEW.md` 未处理项清空至一条**（剩「观察窗之后才崩溃的内核判不出来」，属有意边界）。sudo 路径与 launchd 端到端测试**升格为显式决策豁免**并写明理由：前者要么配免密 sudoers、要么改系统路由表、要么留 root 残留；后者一旦覆盖 `enable`/`disable` 就会在系统 disabled 表留下 launchctl 无法清除的永久记录。下轮审查不要当作覆盖率缺口重新捡起
- **README 同步两处用户可见行为**：TUN 章节说明 DNS 恒为开启（含只锁 `enable`、Mixed 不受影响）；故障排查章节说明「上次异常退出」提示会区分 `退出码 N` 与 `被信号终止（Killed: 9）`

## [4.7.2] - 2026-09-06

文档修正，无功能变更。单测 246。

### 修复

- **README 数据目录注释仍写「镜像偏好」**：v4.7.0 移除 `settings.kernel_mirror`、镜像改为每次按当前环境独立决策后，README「内核更新通道」一节已同步（写明不持久化），但数据目录树里 `settings.json` 的注释漏改，4.7.1 修 quickstart 章节时也未覆盖到。现按 `Settings` 接口实际字段列举（订阅列表、当前订阅、覆写开关、端口覆盖）

### 变更

- **`/wt-done` 补接手场景**：会话中断后由新会话收尾时 cwd 不在 worktree 内，流程第 2 步 `ExitWorktree` 是 no-op，注明可跳过、直接在主仓合并

## [4.7.1] - 2026-09-06

文档与 AI 资产整理，无功能变更。单测 246。

### 变更

- **CLAUDE.md 补表格漂移**：命令处理器表补 `doctor`/`completion`、架构表补 `src/flags.ts`，与 registry 实际注册对齐
- **CLAUDE.md 新增 quickstart.sh 锚点**：明确它是内核下载的 shell 平行实现，改下载/信任逻辑须与 `kernel.ts` 双向同步；已知分歧（默认镜像、无标准版回退、支持 linux 等）标注为刻意
- **CLAUDE.md ↔ CODE_REVIEW.md 去重划界**：规则以 CLAUDE.md 为唯一真相源，CODE_REVIEW 只记验证结论与未处理项，重复条目改为指针；`service.lock` 规则补进 CLAUDE.md
- **CODE_REVIEW 基线更新到 v4.7.0**，单测数同步为 246，清掉已修条目的删除线残留
- **ssh 恢复用法移至 README**（「用 ssh -D 做节点」），CLAUDE.md 保留防重提结论
- **新增项目级命令** `/release`、`/wt-done`（`.claude/commands/`，随仓共享），发布与 worktree 收尾流程固化为可执行指令
- 删除空壳 TODO.md（职责并入 CODE_REVIEW 未处理项）

## [4.7.0] - 2026-09-06

内核下载多通道：gh > 本机代理 > 直连。单测 246。

### 新增

- **内核下载自动选择通道**：默认按 gh（GitHub CLI 直连 GitHub）> 本机代理（代理在跑时经混合端口直连，TLS 端到端）> 直连 的顺序选择，国内网络下不再只能手动敲 `--mirror`。显式 `--mirror`/`--mirror direct` 是最高优先的手动覆盖（`--mirror direct` 同时绕过 gh/代理自动通道）
- **版本查询（GitHub API）经本机代理**：代理开着时 `checkUpdate` 也走混合端口，不再卡在 API 检查这一步。镜像仍绝不作用于 API——下载地址必须由 GitHub 官方 API 给出
- **镜像默认按网络选择**：裸 `--mirror` 有 IPv6 时走 `v6.gh-proxy.org`，否则走 `gh-proxy.org`；短别名 `--mirror cdn|v4|v6|axisnow` 直接指定。可用镜像为 gh-proxy.org / v4 / v6 / cdn / axisnow.gh-proxy.org
- `mihomo kernel` 下载前打印当前通道；下载失败时提示通道优先级与手动覆盖用法

### 变更

- **镜像偏好不再持久化**：`--mirror` 只作用于本次调用，不写入 settings——每次按当前环境独立决策（gh/代理是否可用、网络是否有 IPv6），换网络不会用到上次的镜像。`settings.kernel_mirror` 字段移除
- **`--no-mirror`/`--direct` 移除**：强制直连统一走 `--mirror direct`；旧选项显式报错并给迁移指引，不静默按直连继续

### 安全

- **gh 通道的信任锚**：`gh release download` 只与 GitHub 通信，资产名精确匹配（`--pattern` 是 glob，含 `*?[]` 或路径成分一律拒绝）；大小比对、tar 双守卫、自检、版本对账对所有通道一视同仁

## [4.6.0] - 2026-09-05

全面审查修复：内核更新安全、服务操作并发、订阅下载防降级、补全死代码、循环依赖等 30 项。单测 234（无新增，本轮以修复为主）。

### 修复（中高）

- **内核更新先自检再替换**：此前 `.gz` 路径先删旧内核再自检，自检失败时系统无内核可用（KeepAlive 崩溃循环）；且 `findBinaryInDir` 扫描整个 kernel 目录，归档不含二进制时会选中旧内核自检通过、报「已更新」但二进制没变。现改为解压到临时目录 → 自检 → 版本对账 → 原子替换，旧内核在新内核验证通过前不受影响
- **订阅下载防 https→http 降级**：Node fetch 默认静默跟随协议降级重定向，恶意 WiFi/路由器可 MITM 替换订阅配置。内核下载有 `curl --proto =https` 防线，订阅下载没有。现 fetch 后检查 `response.url` 协议，降级即报错
- **zsh 补全 `dir open <TAB>` 死代码**：group 循环生成的 directory 分支与硬编码分支同名，zsh 取第一个匹配，硬编码的目标补全（`root/subs/logs/...`）永不可达，`dir open <TAB>` 补的是本地文件。bash/fish 正常，只有 zsh 坏
- **`shared.ts` ↔ `start.ts` 循环依赖**：`cleanupLegacyInstallOrThrow` 在 shared.ts 造成 shared ↔ start 运行时循环，注释声称「无循环」已过期。移至 service.ts（`cleanupLegacySystemInstall` 所在地），依赖方向恢复单向
- **`maskUrl` 黑名单改启发式**：黑名单只有 8 个参数名，`uuid`/`sid`/`id` 等常见 token 参数不遮蔽。改为「值长度 ≥16 的 query 参数一律遮蔽」+ 扩充黑名单，误伤率低、token 几乎都是长串

### 修复（中）

- **服务操作跨进程锁**：慢速 `start`（订阅更新 ~10s）期间另一终端 `stop`，start 随后的 `enable` 会把自启位又打开，终态与用户最后一条命令相反。`startService`/`stopService`/`installService`/`uninstallService` 的 enable/bootstrap/bootout/disable 现共持 `service.lock`；start 在锁内再查一次 disabled，若 stop 已跑完则跳过启动
- **`sub add` 补重启提示**：成功切换订阅后运行中实例仍用旧配置，`subUpdate`/`subUse` 都有提示，唯独 `subAdd` 漏了
- **`update` 防静默降级**：当前版本领先 registry（预发/源码安装）时 `npm install -g` 会静默降级。现用 `compareVersions` 比对，领先时跳过并提示
- **未知 flag 校验**：`start`/`logs`/`ow`/`sub`/`status` 此前不校验未知 flag，拼错（`logs -F`）被静默跳过。新增 `assertKnownFlags` 通用校验，白名单外的 flag 一律报错
- **`--no-ssh` 全局检查**：此前只在 `start`/`stop` 报错，其他命令静默忽略。移至 `index.ts` 守卫后、分发前统一检查
- **attached 短选项**：`logs -n200`、`start -u5000` 此前被静默忽略（`parseIntArg` 只认 `-n 200` 和 `--lines=200`）。现支持 `-n200` 形式
- **日志轮转撞名**：同一秒内两次轮转（start 失败后立即重试）会互相覆盖归档。`rotateLog` 和 `restartService` 的 copy-truncate 都加了序号后缀
- **`tryHotReload` pid 校验**：`/version` 探针只确认「端口上是个 mihomo」，挡不住「另一个 mihomo」。新增 `lsof` 取监听 pid 与服务 pid 比对
- **`cleanupLegacySystemInstall` 不再 `|| true`**：`launchctl bootout` 的 `|| true` 吞掉所有错误，daemon 仍在跑却继续 rm plist 并报「已清理」。现只容忍退出码 113（未装载），其余按失败处理
- **ANSI 转义消毒**：服务器返回的字符串（订阅名、错误信息、Content-Disposition）可能含 `\x1b[2J` 等转义序列伪造 CLI 输出。新增 `sanitizeTerminal`，在入口点消毒
- **`parseYamlOrJson` 校验非对象**：JSON 回退路径此前不校验结果类型，标量/数组也能返回。现与 YAML 路径同构，只接受对象
- **`buildConfig` 深拷贝**：`applyOverwrite` 只做浅拷贝，`excludeOverwriteProxiesFromIncludeAll`/`validateConfig` 原地改嵌套对象，污染 `subscriptionConfig` 导致 debug stage1 失真。现深拷贝后再传
- **`saveSubscriptionCache` 防展开垃圾**：损坏的非对象条目（字符串）被 `{...}` 展开成字符键垃圾。现检查类型后再合并
- **`removeSubscription` 锁内删文件**：原始配置的 rm 此前在锁外，与并发 `sub add` 同名存在 TOCTOU。现挪进 `updateSettings` mutator（锁内）

### 修复（低）

- **`sub use -s foo` flag 顺序**：`args[2]` 直取改为 `getNonFlagArg`，flag 写在名字前不再报「未找到订阅」
- **`completion install` 落盘失败包 CliError**：此前抛裸 Error 带完整堆栈，现包成友好提示
- **doctor 内核自检区分 spawn 错误**：`spawnSync` 失败（EACCES/ENOENT）时显示「退出码 null」，现区分 spawn 错误与非零退出
- **`reset` 多目标空目标不报成功**：多目标时空目标（如内核未安装）无删除却出现在成功文案里。现跟踪实际删除的目标
- **`reset overwrites` 关闭覆写开关**：删了覆写文件却留着 `overwrite_enabled=true`，ow/status 显示「已启用 (无文件)」。现重置开关
- **`reset logs` 运行中先停服务**：`needsStop` 从 false 改为 true，避免内核继续写已删 inode
- **补全词表补别名**：顶层补全此前只建议命令主名，不建议 `sub`/`ow`/`dir`/`restart` 等别名。bash `logs` 补全建议不存在的 `--help`，改为 `--lines`/`--follow`/`--open`。三 shell 的 `completion` 分支补 shell 名
- **`mihomo log 1` 尊重编号**：隐藏别名 `log` 的 rewrite 硬编码 `'0'`，`log 1` 跟随当前日志而非归档 1。现尊重用户传的编号
- **startTun 文案**：仅有 root pid 文件无进程时不再打印「清理 0 个残留进程」，改为「清理残留的 root pid 文件」

### 文档

- **TODO.md**：删除「Mixed 模式系统代理开关」条目——该功能已被 owner 在 v4.5.0 明确否决（CLAUDE.md 决策记录），TODO 条目会误导后续实现
- **CLAUDE.md 架构表**：补 `proxy-probe.ts` 和 `spinner.ts` 两个模块（v4.3.0 新增，文档未同步）

## [4.5.0] - 2026-09-05

产品面打磨：补齐「服务常驻」与「用户会回来敲命令」假设之间的缺口。单测 229 → 234。

### 新增

- **`status` 订阅新鲜度**：订阅块新增「更新: N 小时前」行，超过更新间隔时黄标并建议 `mihomo sub update`——服务常驻期间订阅不会自动更新（launchd 只拉起内核，不跑 `start`），陈旧订阅是「运行中（代理不通）」的高频根因。`--json` 的 `subscription` 补 `updatedAt`/`stale` 字段。判断收敛为 `isSubscriptionStale` 纯函数，与 doctor 订阅新鲜度共用口径

- **`sub add` 剪贴板**：交互下不带 URL 参数时自动读取剪贴板（pbpaste），`maskUrl` 遮蔽展示 + y/N 确认后添加——「机场页面点复制 → 终端粘贴」不再需要重打一遍命令。剪贴板非 URL / 非 TTY 环境维持原有报错

- **端口逃生口**：`settings.json` 新增 `ports: { mixed, controller }`，可覆盖默认 7890/9090（与其他代理工具并存的场景）。`getPorts()` 为唯一解析入口，非法值（非 1-65535 整数、两端口相同）直接抛错而非静默回退默认——端口突降会让热重载/UI 连错地址且毫无线索。配置构建、热重载、`ui` 提示、`start` 系统代理提示、doctor 端口检查全部跟随实际值；订阅/覆写仍不可改端口（系统锁定语义不变）

- **`completion install <shell>`**：一键安装补全到对应 shell 的默认位置（zsh → `~/.zsh/completions/_mihomo`，bash → 追加 `~/.bash_completion` 含幂等标记、不覆盖已有内容，fish → `~/.config/fish/completions/mihomo.fish`）。zsh 不自动改 `.zshrc`，fpath 缺失时提示用户补一行。三 shell 的补全词表同步支持 `install` 子命令

- **doctor CLI 版本检查**：落后于 npm latest 时 warn 并提示 `mihomo update`（短超时 4s，registry 不可达静默跳过，不产生红色噪音）——本项目连修多个高危缺陷，老用户需要被提醒升级

### 变更

- **doctor 增加 ports 合法性检查**：`settings.ports` 非法（超范围/非整数/两端口相同/非对象）时报 ✗ 检查项并给修复指引，而不是让整个体检崩在半路
- **`uninstall` 收尾提示彻底清理**：卸载只移除 launchd 托管，结束时提示 `mihomo reset --full`（删数据）与 `npm uninstall -g mihomo-cli`（删包）两步
- **`start` 系统代理提示跟随实际端口**：文案硬编码的 7890 改为 `getPorts().mixed`（配置逃生口后提示不会指错端口）
- **README**：「订阅自动更新」节写实「服务常驻期间不会自动更新」及对策；覆写配置节新增「同时使用多个机场」的 `proxy-providers` 完整示例（单活跃订阅模型下并入第二机场的正路）

### 决策记录

- **不自动配置系统代理、不提供 `proxy on/off` 开关**（owner 决策，记入 CLAUDE.md 服务模型既定决策）：owner 的用法是「日常只有部分程序需要代理，需要者各自配置」，全局代理是错误状态。Mixed 启动保持只提示端口

## [4.4.0] - 2026-09-05

工程去重与安全加固：消除补全词表的第二真相源，doctor 连通性/设置校验复用核心模块，quickstart.sh 对齐 CLI 的安全水位。单测 225 → 229。

### 新增

- **`status --no-probe`**：跳过连通性探测（脚本场景或已知不通时避免 2s 等待）；`--json` 同样支持
- **`start` Mixed 模式提示系统代理**：启动成功后提示「需在系统设置配置 HTTP/SOCKS 代理 127.0.0.1:7890」（TUN 模式无需）——进程活着 ≠ 流量走代理
- **doctor 服务崩溃循环告警**：装着、自启开着、却没在跑且上次非 0 退出时判异常（此前与「用户主动 stop」混为 ok）

### 变更

- **补全词表从注册表派生**：`completion` 的命令/子命令词表不再手写，从 `COMMANDS` 与各命令导出的 `SUBCOMMANDS` 派生（`SubCommand` 加 `description`），新增命令自动进补全；`Command` 加 `hidden` 标记，墓碑命令与隐藏别名不再进词表
- **doctor 连通性复用 `probeProxyConnectivity`**：删掉同步 shim（curl 参数漂移风险），`collectChecks` 改 async；settings 校验复用 `isValidSettingsContent` 纯函数（与 `readSettings` 的损坏恢复同源）
- **doctor 未运行项改中性**：代理连通在未运行时从 ok「未运行，跳过」改为 skip（`·`），汇总单列「N 项跳过」
- **连通性探测超时 5s → 2s**：status 是高频命令，代理不通时不该每次干等 5s
- **订阅更新间隔统一 12h**：删 `isGithubUrl` 与 `DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB`——国内直连 GitHub 更难，更频繁地撞墙只产生失败噪音
- **`update` EACCES 提示去 sudo**：改为「检查 npm 全局目录权限或使用 nvm」，与项目拒绝 sudo 运行的立场一致
- **`status` 复用服务查询**：`getRunningState` 接受可选 `ServiceStatus`，printStatus 一次查询多处复用，省一次 launchctl print + print-disabled

### 安全

- **quickstart.sh 对齐 CLI 安全水位**：内核资产精确匹配标准版命名形态（不再黑名单枚举后缀变体，`-v1` 微架构变体不会再被选中）；tar 解压前双守卫（`-tzf` 查路径穿越 + `-tvzf` 拒符号/硬链接）；curl 全链路强制 https（`--proto '=https'`）；订阅内容校验含节点来源；下载 URL 钉死 GitHub 白名单

## [4.3.0] - 2026-09-05

用户体验打磨：把「成功路径」的确认从「进程活着」推进到「代理真的通」，补齐首次上手引导与自助排障。单测 203 → 225。

### 新增

- **`mihomo doctor` 体检命令**：逐项检查内核可执行性、数据目录可写、settings 有效性、订阅配置与新鲜度、服务状态（含遗留 root 服务）、端口占用、配置可构建性、代理连通性，每项 ✓/!/✗ 并附修复命令；有异常项时退出码 1

- **`mihomo completion <zsh|bash|fish>`**：生成 shell 补全脚本，覆盖全部命令、订阅/覆写/目录子命令与常用选项

- **代理连通性探测**：`status` 与 `start` 结尾的状态展示从二态变三态——运行中但经混合端口发不出真实请求时显示「● 运行中（代理不通）」黄灯，并归因到订阅过期 / 流量用尽 / 节点失效（`src/proxy-probe.ts`，curl 经 127.0.0.1:7890 请求 gstatic generate_204）

- **`status --json`（`-j`）**：机器可读的状态快照（运行状态、连通性、端口、订阅流量/到期/紧急度、服务位），供菜单栏 widget 等脚本集成

- **`mihomo use <name>`** 顶层快捷命令（= `subscription use`，与 `tun` 快捷方式同范式）；`mihomo restart` 作为 `start` 的别名（start 本身即重启）

### 变更

- **首次上手引导**：无参运行的短帮助从静态清单改为上下文感知——缺内核/订阅/服务时按顺序列出「开始使用」步骤，齐全后才显示常用命令；`status` 的「内核: 未安装」「订阅: 未配置」补上行内修复提示

- **`kernel --mirror` 记住偏好**：显式 `--mirror`（裸或带值）把镜像写入 settings，之后裸 `mihomo kernel` 默认走镜像；`--no-mirror` 本次直连并清除偏好。国内用户不必每次更新都带参数

- **状态紧急度着色**：订阅到期 7 天内黄色、过期红色；流量 >=90% 黄色、用尽红色

- **长操作等待反馈**：订阅添加/更新、内核版本检查、CLI 自更新查询在 TTY 下显示转圈动画与计时，非 TTY 降级为静态行（`src/spinner.ts`）

- **`ui` 密钥顺手复制**：配置了 `controller_secret` 时自动 `pbcopy` 到剪贴板，失败回退原提示

- **订阅列表相对时间**：更新时间显示「绝对时间（3 小时前）」，对「该不该更新」更直观

## [4.2.4] - 2026-09-05

内部架构清理，无用户可见的功能或行为变更（命令、配置格式、输出均不变）。单测 195 → 203。

### 重构

- **service 层去 bash 化**：用户域 launchctl 操作（install/start/stop/uninstall/restart）从「拼 shell 脚本 + 自定义退出码协议」改为直接 `spawnSync` 逐条执行、TS 侧判定。消除了退出码协议这层不可测的 IPC 与 shell 注入面，失败时错误信息带 launchctl 原始 stderr。需要 root 的路径（TUN 启动、遗留清理）保留 sudo 脚本。`waitUntilUnloaded` 改为 async 轮询，停止期间 Ctrl+C 可响应

- **命令行选项单表登记**：新增 `src/flags.ts`，`VALUE_FLAGS`（位置参数解析跳过带值选项）与重启透传集合都从单一 `FLAGS` 表派生，替掉 utils.ts 的两张硬编码表——旧设计漏登记即静默失效（`sub use foo -s` 丢选项、`logs -n 200` 的 200 被当位置参数）

- **删死代码**：`http.ts` 未使用的 `secret` 选项（零调用，控制器 Bearer 鉴权一直在 service.ts）；合并 root/平台守卫的重复豁免名单；`getProcessInfo` 的两次 `ps` 合并为一次

### 文档

- CLAUDE.md 瘦身：与代码注释重复的事故叙事换成指针，只留稳定规则与元教训；两条独有的 launchd 实测事实（`plutil -remove` 手工收尾、`KeepAlive.PathState` 否定结论）移入 CODE_REVIEW.md

## [4.2.3] - 2026-09-05

四维度全面扫描（launchd 服务 / 进程生命周期 / 数据层 / 命令层）后修复九项缺陷。共同模式是**防线只铺在主路径**：此前几轮修掉的「报告成功但目标未达成」，同类缺口在 install / tun / stop / uninstall 这些次路径上原样存在。每条都经真实系统实验或复现验证（真实 launchd、三进程锁竞态、真实 release 资产列表），并补了 17 条回归测试（单测 178 → 195）。

### 修复

- **`install` 重装恢复运行不再谎报**。重装时若服务原本在跑，装完会恢复运行并打印「已按原状态重新启动」——但判据只有「bootstrap 没报错」。这正是 v4.2.0 给 `start` 修掉的崩溃循环缺陷（launchd 装载成功 ≠ 进程活着），修复当时只铺到了 start。现在重装路径复用同一套健康确认（观察满 1.2s 窗口），失败时附日志尾部，并明确告知「服务已安装成功，仅恢复运行失败」

- **TUN 启动判据重写**。此前脚本的验证循环是 0.4s 单次检查、首次存活即收口——实测内核可在启动后 180–540ms 才退出，必然漏检；且 `kill -0` 对僵尸进程（bash 尚未收割的已死子进程）同样返回成功，桩进程实测 10 次中 5 次误报存活。现在观察满 1.2s 窗口（与服务路径对齐），判活以 `ps` 的状态列为准（Z 开头或查不到都算死），CLI 收口复核进程真实存活而非只读 pid 文件

- **`stop`/`uninstall` 停不干净时如实报错**。`waitUnloadedSteps` 此前只有等待、没有判定——bootout 未生效时轮询 25 次后静默放行，而任务仍装载着，KeepAlive 约 10s 后把内核拉回，CLI 早已打印「已停止」。现在轮询用尽仍装载即报错；`launchctl` 查询失败（112/125）也不再被当「已卸载」。uninstall 还补上了这段等待，plist 删除失败不再被吞

- **`launchctl disable` 不再吞错**。它是「TUN 用完不 stop 直接关机 → 下次开机崩溃循环」防线的第一层，也是开机自启路径上的唯一一层，此前却整体 `|| true`——失败时 CLI 照常提示「已关闭自启」。现在执行后经 `print-disabled` 复核位真生效，失败可见

- **`stop`/`tun`/`reset service` 认得遗留 root daemon 了**。v4.0 及更早装的 root LaunchDaemon 带 KeepAlive，`stop` 此前只停用户级服务——root 内核被杀后约 10s 就被拉回，「已停止」成谎报；`reset service` 在仅有 legacy 安装的机器上报「已重置」却原样保留。现在三处与 install/uninstall 一致：检测到即引导清理（需要一次管理员密码，sudo 取消会得到可读的错误而非堆栈）

- **文件锁的释放校验所有权**。锁被强夺后（持锁超 10s），原持有者退出临界区时的 `finally` 会无条件删除锁文件——删掉的是**新持有者**的锁，第三方随即直接进入临界区。三进程实测：B/C 并发 4.6s，发生的正是锁要防的静默丢数据，且双方都拿到成功回执。现在锁文件写入 `pid+hrtime` 标识，内容一致才删

- **Intel Mac 不再静默装上最低性能档的内核**。上游 release 同时提供 GOAMD64 微架构变体（`-v1`/`-v3` 后缀），而资产按名称排序时 `-v1` 变体恰好排在标准版之前——旧的判据只排除了 `-go`/`-compatible`，漏了它。于是每次内核更新都装上 baseline 构建，下载、大小校验、自检全部通过，CLI 报「已更新」。现在精确匹配标准版命名形态，任何后缀变体都不会再被选中

- **覆写 `match` 写错直接报错**。键名拼错（`subscripton`）、值滤空或空块时，此前只 warn 一声然后**对所有订阅生效**——用户写了 match 显然是想限定作用域，静默放宽比报错危险得多。现在加载侧与运行侧一致 fail-closed

- **`~proxies` patch 已有节点不再把它踢出自动分组**。patch 订阅已有节点的字段（`~` 的正当用法）不注入新节点，但旧实现照把节点名收进 exclude-filter——节点本就在池子里，被排除后反而从所有 include-all 分组消失，分流静默改变。现在只排除真正新增的节点



三个「报告成功但其实没做到」的缺陷，均实测复现并回归验证。都是 v4.2.1 那个 pgrep 缺陷的同源问题：把「调用没报错」当成「目标达成」。

### 修复

- **`sudo mihomo …` 会静默失效，现在直接拒绝**。服务是用户级 LaunchAgent，域为 `gui/<uid>`；sudo 下 uid 是 0，域变成 `gui/0` —— 一个不存在的域，实测 launchctl 一律返回 125（`Bad request`）而非「未找到」。而 `stopService` 的每条命令都带 `|| true`，125 被吞掉、脚本退 0，CLI 报「已停止」。实际只有杀进程那步生效，plist 的 `KeepAlive` 约 10 秒后又把内核拉了回来（实测 pid 从 52251 变成 52693）。用户看到的是「停了一下又活了」，且自启也没关掉。

  现在以 root 运行时直接报错并引导去掉 sudo（`help`/`version` 豁免）。守卫先于 `ensureDirs`，避免在 `/var/root` 建出一套用户永远看不到的数据目录。不做「读 `SUDO_UID` 回落到真实用户域」的自动降级：sudo 下 `HOME` 是否保留取决于 sudoers 配置，静默改域只会让错位更难查。

  同时收紧了 launchctl 的退出码处理：只有 `113`（目标未找到）才等于「服务未装载」，`112`（域不存在）与 `125`（请求非法）是查询本身没成立，一律报错。

- **TUN 未停就关机，下次开机内核会陷入崩溃循环**。plist 与 TUN 共用同一份 `runtime/config.yaml`，TUN 一跑那份配置就是 `tun.enable = true`。若服务自启还开着，重启后 launchd 会拿这份 TUN 配置、以普通用户身份启动内核 —— 而创建 utun 设备需要 root，内核必然失败退出，再被 `KeepAlive` 每约 10 秒拉起一次。用户开机只看到「代理不通、日志被刷爆」，与上次用过 TUN 毫无表面关联。

  现在 `mihomo tun` 启动前会自动关闭服务自启并提示，TUN 用完后 `mihomo start` 恢复。另加一层兜底：`startService` 拒绝以 TUN 配置启动，防御用户手工改配置或从旧版本升级带来的同种状态。

- **`pkill` 失败仍被记成「已杀掉」**。`killAllMihomo` 无条件返回 true，不看退出码；批量分支还无视返回值直接把 `killedCount` 记成全部。v4.2.1 的 pattern 缺陷正是靠这里才把「一个进程都没杀」统计成「全部杀掉」。现在 pkill 只接受退出码 0（已发信号）与 1（无匹配），2/3 视为失败。

## [4.2.1] - 2026-09-05

修一个让 `stop` 完全失效的高危缺陷。实测复现并回归验证。

### 修复

- **`mihomo stop` 停不掉内核，却打印「不在运行」并退出 0**。内核照常在跑、代理照常生效，只是自启被关掉了——下次开机才「看起来正常」。同一个缺陷还让 `status` 把运行中的内核报成未运行、`start` 看不见需要清理的残留、`reset` 漏掉进程清理。

  根因在识别内核进程的正则：它用了 JS 的非捕获组 `(?:a|b)`，而 `pgrep -f` / `pkill -f` 走 POSIX ERE（`regcomp(REG_EXTENDED)`），ERE 里 `(` 后紧跟 `?` 是语法错误。实测 `pgrep` 直接报 `Cannot compile regular expression ... (repetition-operator operand invalid)` 并以退出码 2 结束、不输出任何 PID，而 `getMihomoPids()` 把这个失败吞成了「没有进程」。`pkill` 同样编译失败，一个进程都不杀却照常返回。于是整条停止链路在「什么都没做」的情况下报告成功。

  该分支是 v4.2.0 引入的（服务经符号链 `mihomo-cli-service` 启动，需同时匹配符号链与真实二进制两种命令行），此前的 pattern 无分组，不受影响。

  除改用 ERE 的 `(a|b)` 外，还堵上了让它能潜伏下来的那个洞：`getMihomoPids` 现在只接受 `pgrep` 的退出码 0（有匹配）与 1（无匹配），其余一律报错——**探测失败不能再伪装成「没有进程」**。回归测试直接调用真实 `pgrep` 编译该 pattern，任何 JS-only 的正则语法都会被当场拦下。

## [4.2.0] - 2026-09-05

修两个「报告成功但其实没做到」的高危缺陷，均实测复现并回归验证。

### 修复

- **`start` 会把崩溃循环报成「已启动」**。内核因配置问题（端口占用、订阅里有内核不接受的字段）启动后立即退出时，`start` 打印「已启动 (PID xxx)」并退出 0，而 `KeepAlive` 正每隔约 10 秒把它反复拉起——用户以为代理开着，实际完全没有代理，日志被崩溃信息刷爆。更别扭的是几秒后 `status` 会显示「不在运行」，同一个状态两条命令给出相反答案。

  根因是 `launchctl bootstrap` 成功只代表**任务被装载**，不代表进程活着，而此前的实现固定 `sleep 500ms` 后取一次 pid 就认定成功。现在 `start` 会观察一个窗口确认内核稳定运行，失败则报错、退出码非 0，并直接附上日志尾部（TUN 路径本就 `tail -25`，服务路径此前什么都不给）。

  判据用 `last exit code` 而非 `runs`：`KeepAlive` 有约 10 秒重启节流，崩溃后 2 秒内 `runs` 仍是 1。实测还发现全新 `bootstrap` 后存在一段**假健康窗口**（`state = running` 且 pid 拿得到，进程其实马上要退出），长度不固定——同一台机器上量到过 180ms 与 540ms，故健康判定不能一看到 running 就收口。

- **服务模式下日志永不轮转**。`rotateAndCleanupLogs()` 只在 TUN 启动路径被调用，而 Mixed（默认模式）走 launchd，于是 `mihomo.log` 无限增长、`logs` 的归档列表恒为空——README 承诺的「自动轮转，保留 7 天」对默认模式根本不成立。唯一的兜底是日志超 10MB 时借重启做 copy-truncate。

  现在 `startService` 在 `bootout` 与 `bootstrap` 之间轮转日志。必须卡在这个窗口：运行中 rename 是无效的，launchd 的 `StandardOutPath` fd 指向旧 inode，改名后内核会继续往归档文件里写。

- **`status` 无法区分「用户主动停止」与「崩溃循环」**：两者都显示「不在运行」。现在检出内核上次非 0 退出时会额外提示，并给出排查与止损命令。

### 改进

- `help` 的说明列改为按最长命令签名自动对齐。此前靠手写空格，实测三段错位（控制组落在第 34 列、其余组第 30 列，`subscription add <url> [name]` 直接溢出）。对齐宽度按显示宽度计算，含中文占位符（`[编号]`、`[镜像]`、`[目标...]`）的签名不再少缩进
- 删除无消费者的死代码：`registerCleanup`/`runCleanup` 退出清理注册表（v4.1.0 移除 detached spawn 后已恒空转，留着会让人误以为信号安全网仍在生效）、`hasRootResidue`、`sleepSync`、`ProcessStatus` 的 `allProcesses`/`hasStaleProcesses`、`StartResult.alreadyRunning`、`downloadSubscription` 的 `persist` 参数
- 文档整理：`CLAUDE.md` 新增「报告成功前必须确认事情真的成立」一节收敛这类缺陷的共性，launchd 实测事实补录本轮四条新结论；`CODE_REVIEW.md` 从两轮历史修复清单（含已删除功能的条目）重写为当前基线的未处理项与已验证结论

## [4.1.0] - 2026-09-05

`daemon` 保活重构为 install/start/stop 服务模型，日常操作全程免密。

> ⚠️ **本版含破坏性变更**（`daemon` / `up` / `down` 命令移除、`start` 需先 `install`、`stop` 语义变化）。
> 版本号按次版本递增而非主版本，升级前请读下面这节。旧命令不会静默失效——执行时会给出明确的迁移指引。

### 破坏性变更

- **移除 `daemon` 命令**，保活从「可选增强」变为 **Mixed 模式的唯一运行方式**。命令族对齐 `install`/`start`/`stop`/`uninstall`：

  | 旧 | 新 |
  | --- | --- |
  | `mihomo daemon on` | `mihomo install`（一次）+ `mihomo start` |
  | `mihomo daemon off` | `mihomo stop` |
  | `mihomo daemon` | `mihomo status` |
  | — | `mihomo uninstall`（新增，彻底移除服务） |

  Mixed 模式不再有用户态直启路径（`startMixedMode` 的 detached spawn + pid 文件已删除），`mihomo start` 在服务未安装时报错引导 `mihomo install`。TUN 不变，仍是临时 sudo 进程。

- **默认改用用户级 LaunchAgent，`start`/`stop` 不再需要密码**。此前是 root LaunchDaemon（system 域），而该域的 `bootstrap`/`bootout`/`enable`/`disable` 一律需要 root——意味着每次启停都要输密码。

  推翻 v3.0.0 那条「必须用 root LaunchDaemon」的结论，依据是 Apple DTS 的原话：「Programs running as **root** are automatically granted local network access」——豁免条件是 root，不是「身为 daemon」。用户级 LaunchAgent 不豁免，但那只意味着走**正常的弹框授权流程**（首次连局域网节点时点一次「允许」，永久生效），并非被静默拦死。原先记录的「静默拦成 no route to host」是**无人登录、没人能点弹框**的服务器场景。

  **loopback 不算本地网络**：`127.0.0.1` 的 SOCKS 出口（如自建 `ssh -D`，v4.0.0 移除内置 ssh 后推荐的做法）完全不触发该机制。只有节点直接指向 `192.168.x.x` / `10.x.x.x` / `*.local` 时才会弹框。

  **升级须知**：老用户升级后，旧的 root LaunchDaemon 仍在。`mihomo install` 会检测到它并自动清理（需一次管理员密码，因为要删 root 拥有的文件），随后装上免密的用户级服务：

  ```bash
  mihomo install && mihomo start
  ```

  `status` 也会检出遗留安装并告警——不认它的话，它带的 KeepAlive 会持续拉起内核抢占端口，而用户态命令动不了它。

- **移除 `up` / `down` 别名**。命令名统一为 `install`/`start`/`stop`/`uninstall`。执行 `mihomo up`、`mihomo down`、`mihomo daemon` 会得到明确的迁移提示而非 did-you-mean 猜测（同 `--no-ssh` 的先例）。

- **`stop` 语义变更**：现在是「停止 **+ 关闭登录自启**」（`bootout` + `disable`），不再是单纯杀进程。只 bootout 的话 enable 位还在，下次登录代理会自己回来，而 CLI 已经报告「已停止」。

- **`reset` 的 `daemon` 目标改名 `service`**（`daemon` 保留为别名）。同时区分「停止」与「卸载」：`reset subs/data/runtime/kernel` 只 **stop** 服务（保留安装），只有 `reset service` 与 `--full` 才卸载。此前一律卸载，会让 `reset runtime` 顺手把用户的安装删掉。

- **配置变更后的重启条件收紧**：此前只要装了保活就恒重启（`isDaemonEnabled() || running`），现在改为仅在**确有实例在跑**时重启。服务已安装但已停止时执行 `sub use x` 不再把它启起来。

### 新增

- `mihomo install` / `mihomo uninstall`；`install` 会自动清理旧版本遗留的 root LaunchDaemon
- `status` 增加「服务」「自启」两行，并检出两类异常：plist 被手动删除但任务仍装载（KeepAlive 会持续拉起内核）、存在旧版本遗留的 root LaunchDaemon（抢占同一组端口）
- 服务以符号链 `kernel/mihomo-cli-service` 启动，「系统设置 → 通用 → 登录项与扩展」中显示为有意义的名字，而非一个没有上下文的 `mihomo`

### 修复

- **`bootstrap` 一个被 disable 的服务是硬失败**（`Bootstrap failed: 5: Input/output error`），不是「加载了但不启动」——本机实测。旧 `restartDaemon` 的 kickstart 回退分支在 bootstrap 前没有 `enable`，在新的 stop 恒置 disable 位的语义下会 100% 失败。install/start 的所有 bootstrap 前均已补 `enable`。
- **bootstrap 失败不再删除 plist**。旧 `enableDaemon` 失败时会 `rm -f plist` 回滚，在新语义下会把「重装」静默升级成「卸载」。现在失败后停在「已安装未装载」这个可恢复状态。
- **plist 被手动删除后的死胡同**：状态查询此前只看 plist 文件，文件不在就直接返回「未安装」，于是 `uninstall` 拒绝执行 `bootout`，而 KeepAlive 仍在拉起内核。现在 plist 不存在时也会探两个域的 launchctl，捞出孤儿任务（实测可复现，同 CODE_REVIEW #6）。
- 进程探测正则同时匹配真实二进制与符号链两种命令行——实测进程命令行记录的是**启动时用的路径**，服务经符号链启动，只认真实路径会漏掉它（残留杀不掉、状态误判）。

### 内部

- `daemon.ts` → `service.ts`，`DaemonStatus` → `ServiceStatus`（新增 `domain`/`installed`/`disabled` 字段），双域抽象 `DomainSpec`
- 状态查询改用 `launchctl print` / `print-disabled`（免 sudo，实测 3ms），取代此前 pgrep + root 属主过滤的近似判断，能拿到真实的 state/pid 与自启位
- `runtime.ts` 门面保留，双轨判据从「是否装了保活」改为「service 还是 tun」
- 新增 `service.spec.ts`（23 例）：`launchctl print` 输出解析（锁定行首单 tab 锚定，防嵌套 endpoint 的 `state = active` 污染）、`print-disabled` 解析（`enable` 同样会留下记录，不能只看是否在表中）、plist 生成、label 路径穿越校验
- `reset` 的裸执行保留清单抽为具名常量 `RESET_PRESERVED_ON_BARE` 并加测试锁定——此前是内联字符串数组，target id 改名时漏改会静默改变裸 `reset` 的行为

## [4.0.0] - 2026-09-05

移除 ssh 隧道功能。

### 破坏性变更

- **移除 `ssh` 命令及全部相关能力**。删除项：`mihomo ssh`（`add`/`up`/`down`/`status`/`rm`）、`start` 与 `stop` 的 `--no-ssh` 选项、`reset` 的 `ssh` 目标、settings 的 `ssh` 字段、数据目录的 `ssh/`。

  演进轨迹：v3.9.0 `tunnel` 统一为 `ssh` → v3.12.0 剥离配置层弱化为「只管端口」→ 本版整体移除。功能价值撑不起维护面——既要防 `--host` 的 `-oProxyCommand=` 注入、又要真实探测端口识别「假活」、还要维护 `started_by` 的 auto/manual 单向提升语义以免 `stop` 误杀，而它做的事等价于用户自己跑一条 `ssh -D 127.0.0.1:1080 -N host`。

  **升级须知**：自己起 `ssh -D`（可用 `~/.ssh/config` 的 `LocalForward` 或系统 launchd 托管），节点与分流规则照旧写在 `overwrite.yaml` 里，无需改动：

  ```yaml
  ~proxies:
    - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
  +rules:
    - DOMAIN-SUFFIX,example.internal,SSH-work
  ```

  老的 `settings.json` 里会留着 `ssh` 键、数据目录会留着 `ssh/` 与 `logs/ssh-*.log`。**不自动清理**：未知键本就被忽略，孤儿目录不影响任何行为，自动删用户数据的风险大于收益。想清干净就手动 `rm -rf ~/.mihomo-cli/ssh`。

### 内部

- 连带移除已无消费者的 `parseStringArg`（`--host`/`--port` 是仅有的两个调用方）与 `ResetTarget.onBefore` 钩子
- `readSettingsList` 泛型包装内联回 `getSubscriptions`（订阅是唯一剩余的列表字段）


---

2026-09 之前的发布记录（1.x–3.x）已归档至 [docs/changelog/CHANGELOG-archive.md](docs/changelog/CHANGELOG-archive.md)，内容原样保留。
