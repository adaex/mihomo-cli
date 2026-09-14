# 代码审查：验证结论与边界

当前审查：2026-09-14，v4.14.0 产品体验收口（未发布）

本轮针对产品审查发现的「成功路径最后一公里」与反馈倒挂问题收口，失败路径的既有防线不动：

| 范围 | 验证方式与结论 |
| --- | --- |
| 覆写加载双出口（本轮最大结构改动） | 底层 `readOverwriteFiles()` 返回 `{ ok, broken }` **不抛错**；合并路径 `loadOverwriteFile()` 有 broken 即硬失败——语法错（含顶层数组/标量）从「warn 一行+退出 0、启动成功但覆写没生效」收口为与语义错同级；诊断路径 `listOverwriteFile()` 带 broken，`ow`/status 红字渲染、`status --json` 新增 `overwrite.errors`，仪表盘不再被 `enabled: no` 一个笔误整体击穿。overwrite.spec 的别名用例改为断言合并路径抛 `CliError` + 诊断路径 broken 带引号 hint；CLI spec 锁 ow 退出 0 且标 `[加载失败]`、status 人读/JSON 两形态。**反向验证**：临时让 loadOverwriteFile 忽略 broken，别名及坏文件 5 条用例转红 |
| 配置凭据脱敏 | 新 `redact.ts`：递归掩码 password/uuid/private-key/pre-shared-key/auth-str/secret，provider 容器（proxy/rule-providers）内 url 走 maskUrl、容器外 url 不动；纯函数+深拷贝，redact.spec 4 组用例。`config` 默认脱敏、`--reveal` 原文，JSON 信封带 `redacted`。CLI spec 锁密码/provider token 不上屏与缺文件 hint。**反向验证**：断开接线后 2 条用例转红 |
| 控制器端口可见 | status 文本/JSON 与 ui 固定显示 `127.0.0.1:<controller>`（settings 非法时 status 不崩、doctor 另有专查项）。help.spec 自定义端口用例锁文本与 JSON。**反向验证**：置空后缀后该用例转红 |
| doctor 内核版本检查 | 与 npm 查询同位置并行发起，4s 超时/失败降级 skip（与 CLI 版本同姿态），warn 指向 `mihomo kernel`；未装内核不列。doctor.spec 只锁检查项存在（ok/warn/skip 取值依赖网络，不写死） |
| `sub update` 部分失败 | 汇总行 + 非零退出 + 逐条重试 hint。CLI 测试用本地 HTTP 桩（200/500 各一）：**必须用异步 spawn**——桩 server 与测试同进程时 spawnSync 阻塞父事件循环，server 无法 accept，子进程 fetch 挂死（父子死锁），实测 30s 超时零请求；改异步后一次通过。成功订阅照常落盘、失败无半成品 |
| clearProxyEnv 精准化 | 只清 `proxyEnvPointsAtSelf(value, selfPort)`（回环 host+端口等于 settings 的 ports.mixed；守卫前无副作用只读 settings，异常回退 7890）命中的 env，企业/外部代理透传。utils.spec 4 组 12 用例锁回环+端口双条件与垃圾值保守保留 |
| 命令级帮助 | `help <命令>` 与 `<命令> -h/--help/help` 在 index 分发前统一拦截（help 放开一个位置参数、version 仍 0 个）；help.spec 7 条含未知纠错与多参数上限；positional-args.spec 移除 `help extra` 旧预期 |
| TUN/内核/订阅文案族 | ① `kernel` 重启提示按运行模式给 `start tun`（复用 sub update 的 kind 判据）+ 本地网络授权提示；② TUN 取消提权/失败时错误带「自启已关、mihomo start 恢复」，成功后与 TUN status 常驻停止行；③ start 无订阅给命令；④ 缺订阅文件三处统一 `sub update`；⑤ `-t` 拒绝 hint 补「内核过旧」另因（config.spec 三条逐行期望同步）；⑥ reset 含 subs 时确认语挑明链接不可恢复（reset.spec 非 TTY 计划断言） |
| ui 剪贴板 | 默认只提示 `-c`、不碰剪贴板；ui.spec CLI 用 PATH 前置桩 open/pbcopy，锁默认不复制、`-c` 才调用 pbcopy，测试不弹浏览器不碰真实剪贴板 |
| npm preuninstall | `scripts/preuninstall.mjs` + package.json `files`/钩子：只警告不自动卸载（升级也触发该钩子，自动 uninstall 会在每次 `mihomo update` 删掉服务）；lifecycle-script.spec spawn 真实脚本，隔离 HOME/label 锁干净环境静默与残留时手动命令两态 |
| 文档同步 | README：镜像 IPv6 说法、config/ui/doctor/help 命令表、卸载段钩子提醒、覆写坏文件行为；CLAUDE.md：clearProxyEnv 新判据、覆写加载双出口约束；registry usage 行（config/ui/help/doctor） |
| 全量验证 | typecheck / **661 测试**（643 → 661，+18）/ Biome（`src/ scripts/` 84 文件，非 0）/ build 全绿。三次反向验证（覆写硬失败、脱敏接线、控制器口）均按预期转红后恢复 |

**未覆盖与待发布后验证**：TUN 真实 sudo 路径（取消密码框、root 进程收尾）与内核真机更新按既有边界不自动执行，仅类型与代码审查；doctor 内核版本项的 ok/warn 具体取值依赖 GitHub，不做硬断言；npm 钩子的真实 `npm uninstall` 接线计划发布后用 registry 拉回包验证（脚本本体已用 spawn 直接跑过）。

---

## 上一轮验证（v4.13.0 过度设计清理，已发布）

本轮针对「设施规模与真实使用面不匹配」做减法，全部以实测使用面为依据：

| 范围 | 验证方式与结论 |
| --- | --- |
| 移除 shell 补全子系统 | 实现 580 行 + 两个 spec 546 行（共占全仓约 6%），服务 20 个命令。实测使用面为零：本机 `~/.zsh/completions`、`~/.bash_completion`、fish 目录均不存在，fish 未安装。更关键的是它**已经坏了且无人发现**——三个 shell 的 flag 词表各手抄一份：fish 整个没有 logs 分支、start 的 `-s`/`-u` 三 shell 全不补、bin 名硬编码 6 处。删除 `commands/completion.ts` 与两个 spec，注册表移除 completion 命令，SubCommand.description 字段（唯一消费者就是补全派生）一并删除，README 删节 |
| 移除 tar.gz 解压设施 | `findBinaryInDir`、`parseTarEntrySize`（兼 GNU/bsdtar 两种布局）、`--max-filesize` 之外的解压总量守卫与 tar 路径穿越/类型两道列表扫描，约 90 行。经 gh 核实上游 v1.19.30 的全部 darwin 资产都是单文件 `mihomo-darwin-*.gz`、从无 tar 包，平台又门控 darwin，该分支生产不可达；唯一测试只覆盖纯函数、解压分支本身零覆盖。现 `.gz` 是唯一资产形态，其他形态显式报错。`findMatchingAsset` 第二个 OR 子句是第一个的真子集，一并删除 |
| 移除其余死设施 | ① `dispatchSubcommand` 的 WeakSet 表记忆化：CLI 单进程只分发一条命令，跨进程不持久，生产零命中，改为每次直接扫描（表仅 1-4 项）；② 四个零外部引用的导出私有化（process-probe 两个、process-stop 两个等待常量）；③ 六个无人覆盖的参数收敛为内部常量/删除（openLogFile 的 label、getNonFlagArg 第三参、requireActiveSubscription 的 emptyMsg、readLogTail/cleanupOldLogs/probeProxyConnectivity 的时长参数）；④ 裸 `--mirror` 不给值时不再枚举网卡猜 IPv6，固定走裸域——有 v6 地址不保证 v6 路由通，探测本就是不可靠猜测，需要 v6 子域的用户显式 `--mirror v6` |
| 既有防线回归 | typecheck / 643 测试 / Biome（`src/` 79 文件）/ build 全绿。测试从 700 降到 643（-57，逐文件实跑基线核准：completion.spec 25、completion-install.spec 21、tar 4、位置参数 completion 用例 5、镜像默认值 2）。日志归档 `wx` 占名、withFileLock 的 deadline 分支等经评估**保留**：前者有双终端同秒轮转覆盖的实测复现，后者是「等待者绝不删新鲜锁」并发不变量的回归锚点 |

---

## 上一轮验证（v4.13.0 入站锁定，已发布）

修 1 项安全缺口并补 1 项防漏机制：`allow-lan`/`bind-address`/`authentication`/`skip-auth-prefixes`/`lan-allowed-ips`/`lan-disallowed-ips` 六个上游 `config.Inbound` 字段从未进过锁定表，远端订阅三行 YAML 即可开出全网卡无鉴权代理；同时把「锁定清单靠人肉对表」换成带上游版本号的字段快照测试。单测 700（+11）

| 范围 | 验证方式与结论 |
| --- | --- |
| 局域网暴露与入站鉴权家族锁定 | 复审前实跑确认缺陷真实存在：隔离数据目录里订阅写 `allow-lan: true` / `bind-address: "*"` / `skip-auth-prefixes: ["0.0.0.0/0"]` 等六键，`mihomo config` 输出原样带着全部六个，**订阅侧与覆写侧都零告警**。上游链条逐处核实（v1.19.30）：`listener/listener.go:genAddr(host, port, allowLan)` 在 allowLan 为真、bindAddress 为默认 `"*"` 时返回 `":%d"`（全网卡，非回环）；`listener/http/server.go` 的 accept 循环里 `if inbound.SkipAuthRemoteAddr(conn.RemoteAddr()) { store = authStore.Nil }`，故 `0.0.0.0/0` 直接把唯一的补偿防线 `authentication` 换成空实现——即远端订阅三行 YAML = 全网卡无鉴权开放代理，与 README「入站默认关闭」直接冲突。六键进 `LOCKED_CONFIG_KEYS`，config.spec 新增 7 条（mixed/tun 各一、组合攻击形态一条、订阅侧静默一条、覆写侧告警一条、inbound-tfo/mptcp 保留一条，另改写两条原 allow-lan 用例）。反向验证：摘掉 `skip-auth-prefixes` 一键即 5 条转红（含快照测试报「未写决定的字段」）。端到端复跑：订阅侧静默剥除、`allow-lan` 回落 false、覆写侧告警带文件名与键名（含 `allow-lan!` / `+authentication` 操作符形式） |
| allow-lan 的归属（BASE_CONFIG → systemConfig） | 锁定 allow-lan 暴露出一个顺序问题：`BASE_CONFIG` 填充循环（判据 `!(key in withOverwrites)`）跑在剥除循环**之前**，故订阅提供该键时默认值被跳过、随后键被删掉，终态里 `allow-lan` 会整个消失（内核零值仍是 false，不可利用，但输出不一致）。改为移出 BASE_CONFIG、由 systemConfig 无条件写 false，与 mixed-port/external-controller 同构——**不动循环顺序**，零副作用面。反向验证：摘掉 systemConfig 那行赋值 6 条转红 |
| 两表混放会留下死配置（本轮意外发现） | 按计划应「把 allow-lan 塞回 BASE_CONFIG 即转红」，**实测 700 条全绿**——预测错了。原因：systemConfig 的赋值无条件，BASE_CONFIG 里那份直接成死配置，既不报错也无行为差异。死配置比缺陷更难发现（下一个人会以为它生效），故补一条不变量用例断言两表无交集。反向验证：塞回后该条转红 |
| 锁定清单防漏机制 | 新增 `config-inbound-snapshot.spec.ts`：冻结一份带上游版本号（v1.19.30）的 `config.Inbound` 字段全集 + RawConfig 控制面键，凡不在锁定表（含 `tls` 这条 config.ts 单独 delete 的旁路）里的字段必须在 `NOT_IN_LOCKED_TABLE` 写明非空理由，否则测试红。另三条守卫：放行理由与已剥除不能同时成立、无快照外的过期条目、锁定表无重复项。**明确抓不住的**：快照是冻结副本，上游新增字段它自己发现不了，仍需人工刷新——该限制写在文件头与 CLAUDE.md，避免下一个人误以为有了完整自动防线 |
| 既有防线回归 | typecheck / 700 测试 / Biome（`src/` 82 文件，实际检查非 0）/ build 全绿；临时数据目录已清理核实 |

---

## 上一轮验证（v4.12.0 全仓复审，结论仍有效）

修 11 项：`listeners`/`tunnels` 入站锁定与补全安装覆盖（两项安全）、status 主文件显示名、`--mirror` 提示指向不存在的命令、zsh 补全 eval 模式不注册、bash 半截标记块死锁、zsh/fish 描述转义（两项预防性），doctor 的 npm 查询串行（性能）、settings.json 非对象时的静默丢弃、bash 重复标记块需卸两次；另收口两处硬编码词表与三处报错文案。单测 689（+32）

| 范围 | 验证方式与结论 |
| --- | --- |
| listeners/tunnels 锁定 | 复审前实跑确认缺陷真实存在：订阅里写 `listeners: [{type: socks, listen: 0.0.0.0, port: 18080}]`，`mihomo config` 输出原样带着它——即远端订阅可在全网卡开出无鉴权 SOCKS 入站，与 README「入站默认关闭 / 入站与控制面由本工具独占」直接冲突。两键进 `LOCKED_CONFIG_KEYS`，config.spec 新增 4 条（mixed/tun 各一、allow-lan 不作兜底一条、iptables 保留一条）。反向验证：摘掉两键恰好 3 条转红、其余 48 条全绿。端到端复跑：订阅侧静默剥除、覆写侧告警带文件名与键名。**注：那一轮「allow-lan 不作兜底」只锁了「别拿它当别的键的兜底」，没锁 allow-lan 自身——v4.13.0 才补上** |
| status 主文件显示名 | `shortOverwriteName` 先剥前缀 `^overwrite\.?` 会把点一并吃掉，`overwrite.yaml` 剩 `yaml`、非空使 `\|\| '主文件'` 永不触发——最常见的单文件配置显示成 `覆写: 已启用 (yaml)`（实测）。改为先剥扩展名再剥前缀。该展示此前零覆盖，补 3 条（主文件单独、与扩展文件并列、`.yml` 与不适用补充行）。反向验证：还原旧顺序 3 条转红 |
| `--mirror` 提示自洽 | 重复 `--mirror` 的 hint 写「可用镜像见 `mihomo kernel --help`」，实跑该命令得到「未知的选项: --help」——`--help` 只是顶层 help 的别名，命令级一律走白名单报错。改为直接列 `AVAILABLE_MIRRORS`。新增用例断言 hint 不含 `--help` 且逐个列出镜像，两种写法（空格/等号）各验一次 |
| 既有防线回归 | typecheck / 689 测试 / Biome（`src/` 81 文件）/ build 全绿；临时数据目录、测试 plist、进程均已清理核实 |

### 第四轮复核（构建配置、契约与并发，未改动行为）

读了此前从未看过的 `tsup.config.ts` / `tsconfig.json` / `biome.json` / CI workflow / husky hook，并实测了几类契约，**只发现一处需要动的**（测试的 `python3` 依赖，见「未覆盖与待复核」）。其余结论：

- **JSON 契约稳固**：空环境、settings 损坏告警期间、有 warnings 时，`status --json` 与 `config --json` 的 stdout 始终是可整体解析的 JSON，告警一律走 stderr（三种场景各实测一次）
- **跨进程锁未丢条目**：6 个进程并发 `addSubscription`（纯设置写入、不经网络，避开「下载失败回滚」把结果抹平）最终 6/6 落盘，与 `paths.ts` 记载的锁语义一致
- **TUN 模式判定三处一致**：落盘 `runtime/config.yaml` 为 TUN 形态时，`status`（人读与 `--json`）、`config` 推导的模式都是 tun，未出现分叉
- **README 的命令示例全部存在于注册表**（脚本比对，非肉眼）；`overwrite.applied` / `overwrite.files` 的文字描述与实测输出相符
- CI 在 macos-latest 用 Node 22.22.1（与 `engines` 下限一致）跑 typecheck/check/test/build，四道全在；husky 的 pre-commit 走 lint-staged。`npm run check` 只在 error 级失败，warn 级不拦——上一轮那 4 条 `noNonNullAssertion` 警告因此没被 CI 挡住，是我自己 `biome check` 时才看见的，**改完代码别只看 `npm run check` 的退出码**

### 补全模块（本轮新覆盖，此前只有生成侧词表测试）

| 范围 | 验证方式与结论 |
| --- | --- |
| install 覆盖非本工具文件 | 真跑 CLI + 临时 HOME 实测：手写 `_mihomo` 被 `install zsh` 静默销毁（退出 0、无备份），而**随后 `uninstall` 删得干干净净**——因为此时指纹已匹配。安装侧无守卫使卸载侧的守卫形同虚设。判据收口成 `productFingerprint`，两侧共用。反向验证：还原无条件写入后 2 条转红 |
| eval 模式不注册补全 | 真实 zsh 实测：`eval "$(mihomo completion zsh)"` 后 `_comps[mihomo]` 前后都是 0，stderr 有 `_arguments:comparguments:327: can only be called from completion function`，而 `eval` 返回 0。改用 `compdef _mihomo mihomo mhm mh mihomo-cli` 后四个别名 `_comps` 全为 1；**两种结尾对 fpath 文件安装都有效**（各验一次），故换成 compdef 是纯改进、无需分两种模式 |
| bash 半截标记块 | 实测复现死锁：只剩起始标记时 install 报「已安装过」、uninstall 报「未找到标记」，两条都退出 0 且不改文件。install 幂等判据改为要求成对标记后可自愈。反向验证：还原单标记判据 1 条转红 |
| zsh/fish 描述转义 | zsh 实测 `print -r -- 'it''s a test'` → `its a test`（RC_QUOTES 默认关闭时 `''` 是拼接不是转义），改用 `'\''`；fish 未转义反斜杠时生成 `-d 'desc\'` 使字符串失闭合，改为先转义 `\` 再转义 `'`。两者当前注册表都触发不到，属预防性。注入含反引号与 `$(...)` 的描述实测**不构成命令注入**（单引号内不求值，`zsh -n` 通过且不创建文件）——是描述损坏，不是注入 |
| 词表派生 | 确认两处硬编码：bash 的 `dir` 分支写死 `open`、fish 的目录目标行写死四个 `directory` 别名，均与模块头部「不手写第二份词表」的声明矛盾。改为派生，并加用例注入额外别名验证其流入 |
| bash 重复标记块 | 实测：文件里有两份块时，第一次 `uninstall` 打印「已移除」却留下一份仍生效的 `_mihomo_completions` 定义——报告成功但事情没做完。改为循环剥离到 `hasBashMarkerBlock` 为假，多份时如实告知移除了几份。反向验证：把循环限成一次，2 条转红 |
| settings.json 非对象 | 实测 `[1,2,3]` / `"str"` / `42` / `null` 四种形态：此前既不备份也不告警，随后一次 `ow off` 就把文件整个覆盖成默认内容，原件无声无息地没了（与「JSON 解析失败」是同一类文件不可用，处置却不同）。现统一走备份 + 告警，备份内容经断言确认是原件。反向验证：还原 `return {}` 后 4 条转红 |
| 报错文案 | 三处：不接受任何选项的命令打印空的「可用选项: 」（看着像工具没填上）；`-h`/`--help` 是顶层 help 的别名、命令级不接受，用户很自然会试却得不到指引；`completion install ZSH` 的用法行漏掉 `install`，照提示改会丢掉这一步。均已修并加用例 |

计时用例的教训单独记：先写的是墙钟版（桩各睡 N 秒、断言总耗时 < 1.75N），**连调两次阈值仍在套件变大后误红**——单独跑 2.44s、与其他 suite 并行 2.93s、套件再变大涨到 3.27–3.94s。墙钟同时受机器负载、`node --test` 的 suite 并发与 tsx 转译影响，放宽阈值只是把误红概率往后推，而误红的表现是「并发结构坏了」这种指向完全错误的失败。最终改为让两个桩各自记录进入/退出时刻、直接断言**两段区间有交集**：与被测性质一一对应，对机器快慢免疫，串行实现下两段首尾相接、交集必然 ≤ 0。**凡是想用耗时阈值证明并发的地方，先问能不能直接观测交叠。**

### 性能：逐条测量，只有一处真问题

复审时把各命令在隔离数据目录里实际测了一遍（`dist` 产物，多次取样取 min），不靠读代码猜热点：

| 命令 | 耗时 | 结论 |
| --- | --- | --- |
| `version` | 25ms | 裸 `node -e 0` 是 17ms，模块加载只占 7ms，无优化空间 |
| `status --no-probe` | 29ms | 只调一次 `launchctl print`（桩验证），无冗余查询 |
| `config`（300 节点 / 2000 规则） | 40ms | 覆写文件 0/5/20 个耗时相同（45–46ms），合并不随文件数增长 |
| `doctor` | **839ms** | 其中 `npm view` 独占 782ms，其余全部检查合计 74ms |

只有 `doctor` 值得改：`npm view` 是纯网络往返且不依赖任何前序结果，改为开头发起、末尾 await。同一桩环境对比，**装了内核时 1070ms → 837ms（省 22%）**；没装内核时本地检查太短，只省约 47ms——此时下界就是 npm 查询本身，这是并行的固有上限，不是实现问题。

新用例锁**并发结构**而非某次耗时（桩 npm 与桩内核各睡 2s，串行 2×、重叠 1×，阈值 1.75×）。两处值得记：① 先写的 1s/1.6× 版本实测落在 1.46–1.49s、余量仅 7%，CI 必然偶发误红，改为 2s 让固定开销占比减半；② 用例内先断言两个桩都真被调用了，否则「跑得快」可能只是因为压根没执行——正是 v4.10.0 那条假阳性教训的同族。反向验证：改回串行后该用例 6530ms 转红。

顺带复验两条既有防线仍有效：覆写 glob 的病态输入（`*a`×20 配 64 字符订阅名）29.8ms（旧正则版是 70 秒）；YAML 别名上限 150 次引用放行、300 次挡下并给出可读错误。

---

v4.11.0 改的是展示层一处误导：status 的覆写行此前列「目录里未被 `enabled: false` 停用的文件」，不按 match 过滤，只对别的订阅生效的文件与真正生效的混在同一行、形态完全相同，用户会拿它解释自己观察到的行为。修复后主行只列本次参与合并的文件，未命中的逐个展开原因。复查自己上一条提交时又发现 `status --json` 新增的 `applied` 漏了全局开关这道过滤，导致 `ow off` 后同一份 JSON 里 `enabled:false` 却列着生效文件、与人读形态打架，一并修掉。单测 657（+8）

上一轮（v4.10.0）在实现两项覆写增强的同时，连带堵上元数据键的操作符/大小写绕过、`*` 开头值的静默跳过，以及 glob 实现自身的灾难性回溯（后两者为复审时实测发现，其中回溯一条推翻了当时初版写下的「输入面受控、可接受」结论）。单测 649（+46），验证结论见下方「覆写作用域与单文件开关」一行。

上一轮（v4.9.2）起因是复核 v4.9.1 的 CODE_REVIEW 声明本身：文档称锁定键「逐个回上游 General 段核对」，照着上游 `RawConfig`/`config.Inbound` 重新对表时发现 `ss-config`、`vmess-config` 两个入站服务端从未被任何文档、清单或测试提及——不是待定决策，是纯遗漏。它们与已锁的 `tuic-server` 是同一个 `Inbound` 结构体的并列字段，同由 `executor.updateListeners()` 起监听，只因形态是一行 URL 而非映射而被漏看。修 1 项（安全边界），并修正 v4.9.1 文档里两处与事实不符的记述（「待发布」、测试数 596）。单测 603（+4）

上一轮（v4.9.1）在 v4.9.0 发布当天复审：一人通读并发状态机全线（service/runtime/paths/start/stop/reset/install 命令层），三个分模块深审（覆写与配置、命令层、进程下载），重要线索逐条实测或回上游源码核实；收尾时回上游 General 段逐键复查又补出 `tuic-server`/`external-doh-server` 两个入站面，并修正了锁定告警对真实订阅刷屏的自引入回归。修 15 项：入站/控制面安全边界、一条热重载自愈缺口，其余为一致性收口。两条子审查报的缺陷经对照实验排除（pkill 自匹配、见下）。launchd 的真实启停与 TUN 提权流程仍未做真机端到端复测

规则见 CLAUDE，修复历史见 CHANGELOG；本文保留验证方法、仍有效的实测事实与未覆盖风险，改相关代码时同步更新

## 上一轮验证（v4.11.0 status 覆写行按 match 分列）

| 范围 | 验证方式与结论 |
| --- | --- |
| status 覆写行分列 | 由 commands/overwrite.spec 真跑 CLI 锁住：主行只列命中当前订阅的文件、未命中的逐个展开「文件名 + 当前订阅 + 作用域」、两类失效分开计数（不适用 vs 已禁用）、全命中时无补充行。判据复用 `matchesScope`（`listOverwriteFile(scope)` 新增展示用的 `matched`，合并闸门仍只有 `selectActiveOverwriteFiles`）。反向验证：让 status 不传 scope 模拟漏改，5 条行为用例转红，另 2 条（`ow` 列表不判 match、全命中无补充行）按设计恒绿——后两条测的是不变量，恒绿即符合预期。边界实跑：切到命中的订阅后该文件回主行、补充行消失；无活跃订阅时 `matched` 为 undefined（未判定 ≠ 未命中）退回旧行为，不冒出假的「不适用」 |
| `--json` 契约 | `applied` 三道过滤与 `buildConfig` 对齐（全局开关 → 文件级 `enabled` → match），`files` 保持旧契约不变。全局开关这道是复查上一条提交时补的：漏了它会让 `ow off` 后 `enabled:false` 与非空 `applied` 同时出现在一份 JSON 里，且与人读形态「已禁用、不列文件」矛盾——实跑 `ow off` 复现后修复并补回归用例 |
| 既有防线回归 | typecheck / 657 测试 / Biome（主仓 85 文件、`src/` 81 文件）/ build 全绿；`ow` 列表输出与 v4.10.0 完全一致（不传 scope 的旁路未动） |

---

## 上一轮验证（v4.10.0 覆写 match name 通配与文件内 enabled）

| 范围 | 验证方式与结论 |
| --- | --- |
| 覆写作用域与单文件开关 | match 的 `name`/`subscription` 同义归一、订阅名 glob 全串匹配与「除 `*`/`?` 外全字面」（反向验证：去掉全串锚定 3 条转红。注意无通配的 pattern 走精确比对快路径，字面性只有在「特殊字符 + 通配」同时出现时才被考验，用例必须含 `a.c*` 这类形态；glob 已改为双指针实现、不再有正则，详见「未覆盖与待复核」首条）；文件内 `enabled` 只认真布尔（`no`/`off` 是 YAML 字符串，实测 js-yaml 5.3.0）、被停用文件仍加载并校验 match；两道过滤合一于 `selectActiveOverwriteFiles`（反向验证：去掉 enabled 过滤 2 条转红）；元数据键的操作符形式（`enabled!`/`match!`/`<enabled>`）与大小写空白近失（`Enabled`/`MATCH`/`enabled `）均被拒——两者此前都能绕过剥离、两头落空（文件不停用 + 键进运行配置 + 内核不报错），大小写这条是复审补出的（反向验证：摘掉该检查 1 条转红）。展示层由 commands/overwrite.spec 真跑 CLI 锁住「停用文件仍列出并标注」（反向验证：改成加载时丢弃 4 条转红）——纯单元层面测不出这条，因为丢弃后筛选结果同样为空 |
| 内核侧协同 | 真内核（v1.19.30）`doctor` 全链路在覆写生效下通过；内核拒绝时的提示按 match 过滤后回显 `overwrite.a.yaml (name=edu*)` 并附 `~?key` 修复建议，同样写错的**停用**文件既不进该清单也不触发拒绝。元数据剥离在 mixed 与 tun 两种模式下各验一次（直接调 `buildConfig`，不经 `config` 命令——该命令不接受模式参数，误用会得到「命令报错 = 0 条泄漏」的假阳性）；多文件加载顺序为主文件优先，中间的停用文件不覆盖前者 |
| 既有防线回归 | typecheck / 649 测试 / Biome（实际检查 81 个文件）/ build 全绿；`reset overwrites` 与文件内 `enabled` 互不干扰（删文件即带走该键，全局开关照常恢复默认开启） |

---

## v4.9.2 验证（历史，结论仍有效）

| 范围 | 验证方式与结论 |
| --- | --- |
| ss-config / vmess-config 锁定 | 实测 `buildConfig`：订阅与覆写（含 `vmess-config!` 操作符形式）提供时均剥除，覆写侧告警带文件名与键名；`allow-lan: false` 与剥除是两套独立机制，单独一条用例锁死「别拿 allow-lan 当兜底」。上游依据逐处核对（v1.19.30）：`config.go` 的 `RawConfig`/`Inbound` 两个结构体里 `ShadowSocksConfig`/`VmessConfig` 与 `TuicServer` 并列；`hub/executor/executor.go:updateListeners()` 对三者各调一次 `ReCreate*`；`listener/shadowsocks/utils.go:ParseSSURL` 与 `sing_vmess` 的 `ParseVmessURL` 把 URL 的 host 直接当 `Listen`，`New()` 里 `strings.Split(config.Listen, ",")` 逐个 bind——**不经过 `genAddr`**，故 `allow-lan`/`bind-address` 对它们无效（那两个只作用于 HTTP/Socks/Redir/TProxy/Mixed）。反向验证：从 `LOCKED_CONFIG_KEYS` 摘掉这两键，恰好 4 条新用例转红、其余全绿 |
| 既有防线回归 | typecheck / 603 测试 / Biome（实际检查 80 个文件）/ build 全绿；v4.9.1 的锁定家族、告警只对覆写、待定入站面三组用例均仍通过 |

---

## v4.9.1 复审验证（历史，结论仍有效）

单测 599（+48），关键新用例在恢复缺陷时均转红（反向验证过）

| 范围 | 验证方式与结论 |
| --- | --- |
| 控制面与入站锁定 | 实测 `buildConfig`：订阅带 `external-controller-tls/-unix/-pipe/-cors/-routing-mark/-doh`、`tuic-server` 与顶层 `tls` 段时全部剥除；订阅侧无锁定 warning（机场订阅普遍带端口段，静默剥除），生效覆写文件含锁定键（含 `+key`/`key!` 形式）才有带文件名的 warning；`listeners`/`tunnels`/`iptables` 现状保留有测试锁死。键名逐个回上游 `MetaCubeX/mihomo` `config/config.go`（General 段）、`listener/config/tunnel.go`（tunnels 含 address 是入站）、`hub/route/server.go`（TLS 需证书、unix/doh 无前提、CORS 作用于主控制器）核对——**但这次核对漏了同段的 `ss-config`/`vmess-config`，v4.9.2 才补上**。反向验证：恢复旧删除清单或恢复订阅侧告警，对应用例即红 |
| 热重载查询失败回退 | PATH 前置计数桩 launchctl（入口 print 成功→热重载 print 退 112→kickstart→健康窗恢复 running）+ 子进程真实模块：查询失败走 kickstart 并健康确认，不再整体失败。反向验证：getServiceStatus 移回 try 外用例即红 |
| 补全指纹 | 临时 HOME 跑真实 CLI：仅含 `#compdef mihomo` 行业首行的第三方补全、fish 只循环 mihomo 的手写文件均拒绝删除；本工具完整指纹正常装卸；XDG_CONFIG_HOME 下安装/卸载同位置。反向验证：恢复弱指纹两条用例即红。zsh/bash 生成脚本经 `zsh -n`/`bash -n`，fish 仍未装 |
| 覆写矛盾操作符 | `+x+`/`~x!`/`~?x!`/`<x>+!`/`~<x>!` 抛 CliError；裸 `+`/`~`/`!`/`~?` 报空键名；`~?key`、`<+key>!`、`+<+key>` 等合法单一操作符不误伤 |
| secret 类型 | 非字符串 controller_secret 在 buildConfig 报「配置错误」；字符串 secret 两个展示出口脱敏；`config --json` 信封 `{config,warnings}` 下用户配置自带的 `warnings` 键不被顶替 |
| 内核下载 | `--fail-with-body` 在 buildKernelCurlArgs 纯函数用例锁定；`parseTarEntrySize` 对 bsdtar（第 5 列）与 GNU tar（owner/group 第 3 列）两种 `-tv` 布局取大小，目录行计 0，超 512MB 上限被调用方拒绝 |
| 命令层口径 | 真实 CLI（隔离目录 + 隔离 label）：`ui ""`/`dir open ""`/`sub update ""` 报错；`ow on -u`/`sub use x -u5s` 未运行也报错；重复 `--mirror` 报错；`ow -s`/`dir -x` 给未知选项文案；resolveUiName 纯函数测大小写归一 |
| 损坏备份 | 子进程真实模块连写两次损坏内容：settings.json 与 cache.json 的 `.bak` 都只保留第一份原件 |
| 既有防线回归 | typecheck/599 测试/Biome/build 全绿；4.9.0 的锁三进程编排、热重载计数复读、TUN 模式重启、sub 白名单等用例全部仍通过 |

**复审实测排除的疑似缺陷**：

- 「`sudo pkill -f <PATTERN>` 匹配自己命令行、杀掉 sudo 父进程」：对照实验证明**不成立**——`escapeRegExp` 把点转义成 `config\.yaml`，进程命令行里出现的是带反斜杠的正则源码、正则却要匹配字面点，恰好坏掉自匹配；把 `\.` 换回 `.` 的对照组立刻自匹配。三个 root 脚本同此结论，当前不加行首锚（未来若改用未转义拼接必须重验）
- 「detached 孙进程可作端到端到达标记」：`spawnSync` 子进程退出过快时，其 detached 的孙进程（如 `open`）可能来不及执行，PATH 桩收不到调用——openUrl 本就是 fire-and-forget（见 open.ts 注释），这类断言要抽纯函数测，不要靠桩文件
- 文件锁 stat→unlink 不复核 inode：仅在等待者被冻结（合盖/换出）叠加系统时钟前跳时可利用，微秒级窗口，接受为已知理论缺口

---

## v4.9.0 深审验证（历史，结论仍有效）

类型检查、551 项测试（+211）、Biome（实际检查 79 个文件）与构建通过；registry 产物拉回实跑（version、紧贴值报错）确认 tarball 完整。**时序用例的负载敏感性已收口**：发布验证时一次与 build 并行的 `npm test` 假失败（持锁时长断言的桩 sleep 贴预算上限，开销在并行负载下膨胀即破阈值）。修法是护栏分工——时序断言只兜「预算内的慢不破阈值」（桩 sleep 2.5s→2.0s，余量 3.8s），「调大单次预算/往锁内加调用」改由常量关系断言承担（调用次数 × 单次预算 < 强夺阈值，反向验证：预算调 4s 精确转红）；并行 build+test 三轮压测全过

| 范围 | 验证方式与结论 |
| --- | --- |
| stop 的提前返回 | commands/stop.spec 用真实 CLI 打隔离目录 + 不存在的 label：该组合天然走「不在运行」分支，一次 launchctl 写操作都不做。断言消费者可见的后果（`shouldAbortStartOnDisable` 判为变了）而非文件内容，并含负向对照（`status` 不得改变计数） |
| 游离内核清理 | 同上文件：真实桩内核（命令行绑定隔离目录）被杀后同样记录；判活以 `ps` 状态列为准，不用 `kill -0`（僵尸进程会骗过它） |
| reset 的边界 | commands/reset.spec 补一条：`needsStop` 为真的 `reset logs` 记录停止，纯配置的 `reset ow` 不记录 |
| 测试有效性 | 临时注掉两处 `recordServiceStopped` 复核，两条用例即转红，确认不是恒真断言 |
| Node 版本守卫 | commands/node-guard.spec 伪造 `process.versions.node` 跑真实入口（真装旧 Node 连 tsx 都未必起得来，反而测不到守卫）：四个命令被拒且退出非 0、help/version 豁免、被拒时不留数据目录、满足下限时放行 |
| 补全装卸 | commands/completion-install.spec 把 HOME 指向临时目录跑真实装卸，断言文件最终内容：bash 卸载后用户自有内容完好且标记块消失、反复装卸不留空文件、非本工具产物拒绝删除且文件仍在 |
| config 命令 | commands/config.spec 全部在没有 runtime/config.yaml 的目录里跑（锁住「重新推导」这一性质）；输出经 js-yaml 实际解析确认是合法 YAML，secret 已脱敏，`--json` 同样脱敏且携带 `warnings`（空时为数组） |
| 补全脚本语法 | 生成的 zsh/bash 脚本经 `zsh -n`/`bash -n` 校验；fish 未装，未校验 |
| 配置构建 | config/config-dns/overwrite 测试验证 JSON/YAML、形态错误、覆写 DSL、作用域与 TUN DNS；节点、分组和规则不再被隐式修复；`~?key` 未命中即跳过并告警（反向验证：短路成追加后精确三条转红）；覆写操作符只在顶层生效、嵌套键一律字面（反向验证：恢复内层 DSL 解析后通配键/告警用例共九条转红），校验失败提示的覆写清单按作用域过滤、文案逐行锁定；订阅自带 port/socks-port/redir-port/tproxy-port/secret/external-ui 被剥掉、生效值取 settings；fake-ip 注入 sniffer 的判据是合并后 dns 的 enhanced-mode（mixed + 订阅 fake-ip 也注入），`sniffer: null` 不注入（内核把 null 解码为零值，-t 不拒） |
| 原生配置校验 | mihomo v1.19.30 在临时目录执行 -t：Mixed/TUN 合法配置通过；缺失节点、规则目标、重复节点名和缺失 provider 被拒绝；拒绝后旧 config.yaml 保留、候选文件清理；顶层未知键（如元数据键 `enabled`）内核**不拒**，实测 `enabled: false` 照常通过——剥离元数据键完全是 CLI 的责任，没有内核兜底 |
| 配置提交协议 | subscription-prepare.spec 用隔离桩内核验证 -t/-d/-f、并发临时文件、拒绝时保持旧配置、提交只写最终配置，并验证拒绝提示带出生效的覆写文件与作用域（无覆写生效时不出现该段） |
| 设置 | settings.spec 用真实子进程验证每次读盘、mutator 失败不写入，以及 4 进程并发更新设置和订阅缓存不丢条目；端口校验在合并默认值之后执行，单侧配置撞另一侧默认报错 |
| reset | commands/reset.spec 用临时数据目录和独立服务 label 跑真实 CLI，检查全量/部分/不同目标顺序、不重建设置、默认覆写开关与下载残留清理 |
| 命令与选项 | 注册表/补全与参数测试；带值选项 exact / attached / 等号三种形式由 `matchValueFlagToken` 统一判定（白名单、`parseIntArg`、重启透传三处共用），不变量测试遍历 `FLAGS` 锁死「白名单接受 ⟹ 下游可消费」（反向验证：临时让透传丢掉 attached 即转红）；布尔开关拒绝附加值，未知输入统一报错；sub 白名单按子命令校验（13 条用例，反向验证：换回全组放行恰好 5 条转红）；多余位置参数在全部消费点报错（positional-args.spec 25 拒 + 19 放行） |
| 服务并发 | service-concurrency.spec 用 PATH 前置桩 launchctl + 桩 controller 驱动真实模块（launchd 零接触）：热重载成功后计数已变则报「启动已取消」（反向验证：撤掉复读恰好转红）；stop 锁内慢 launchctl 的持锁时长断言低于 `LOCK_STALE_MS` 真实常量（反向验证：还原 5s 超时实测持锁约 12s 超阈值，原缺陷复现） |
| 文件锁 | paths.spec：deadline 到点不抢新鲜锁（等待者各自过线也只等对方释放，双等待者临界区不重叠）；反向验证：还原无条件 rmSync 后以正确原因转红 |
| 归档轮转 | log-files.spec：原子占名（openSync 'wx'）后双进程同时分配拿不同路径、同时轮转同一日志恰一份归档；反向验证：换回 existsSync-then-rename 后 4 条转红且两次运行稳定复现覆盖 |
| 网络路径 | kernel/http.spec：代理路径 curl 加 `--fail-with-body` + 状态码复核（3xx 不跟随时退出码也是 0，故双保险）；真实 CONNECT 隧道代理对 api.github.com 端到端取到版本，连接拒绝口径不变；API 查询异步化（130s 不再阻塞事件循环）；https 判定经 `new URL` 规范化，大写 scheme 不再绕过降级守卫 |
| TUN 模式判据 | runtime.spec：`restartModeFor` 纯函数锁「TUN 在跑即 tun（含服务已装组合）」，真实桩内核 + pid 文件端到端验证 `getRuntimeMode` 答错时决策仍答 tun |

原生 -t 只验证配置解析，不能证明节点可达、端口可绑定或真实 TUN 路由正常；服务健康与代理连通性检查仍有独立价值

## 已有验证仍支持的结论

以下结论来自已有测试或前次真机实测，本轮未全部重新搭建现场

- 原子写临时名带 pid 与进程内序号；锁释放校验所有权，陈旧锁可恢复，根目录锁不会被 runtime/subscriptions 重置带走（paths.spec）
- YAML 解析保留共享引用与锚点，JSON 无需第二套解析；match 为空或键名错误时拒绝加载（config/overwrite 测试）
- process-probe.spec 调真实 pgrep 验证 POSIX ERE；process-stop.spec 用路径隔离的桩进程跑真实 pkill，覆盖批量清理与 PID 复用
- service-exitcode.spec 只读调用真实 launchctl，确认 113 未装载、112/125 查询失败；service.spec 验证顶层字段、信号死亡与停止计数判据
- root-guard.spec 验证入口在创建数据目录前拒绝 root；用户态 LaunchAgent 无权创建 TUN
- launchd 的 terminating signal 与 last exit code 两字段互斥；需要 describeExitCause 同时覆盖
- disabled label 的 bootstrap 硬失败，enable 必须在前；bootstrap 返回 0 不表示内核已健康，TUN 的 kill -0 也不能排除僵尸进程
- 内核四种下载通道曾各自下载真实产物；kernel.spec 覆盖通道选择、标准资产选择、curl/gh 参数纯函数。资产形态按上游 v1.19.30 实测只有单文件 `.gz`（gzip 解压，maxBuffer 256MB 即体积上限），tar 设施已移除；非 `.gz` 资产显式报错
- 上游 mihomo v1.19.30 的已查资产未提供 checksums；来源约束、大小比对和执行自检应保留，不能写成已验证哈希
- HTTP 超时覆盖响应体，错误体读取限量；订阅 URL 按完整 URL 脱敏，不能按合法逗号拆开
- 归档列表与清理使用相同判据，同秒多次轮转的序号后缀可被列出（log-files.spec）
- 覆写「未命中即追加」是 ssh 出口与 provider 场景依赖的承诺，故不改 `~key`；「只改已有、不新增」由 `~?key` 显式表达，跳过时告警。不在 CLI 复制一份分组必填字段校验（字段集随内核漂移），残缺元素仍由 `-t` 拒绝

## 未覆盖与待复核

- 健康观察窗只覆盖启动初期，之后的 OOM/panic 由 status/doctor 展示异常退出；延长 start 到无限观察不在目标内
- install 恢复分支的并发只能手工双终端复现（需真装了内核的机器）：自动化要么得真跑 launchctl enable/disable（留永久记录），要么退化成对实现清单的断言。已修；热重载成功分支（PATH 前置桩 launchctl + 桩 controller）与查询失败回退分支（计数桩 launchctl）均已自动化（service-concurrency.spec，不碰真实 launchd），install 恢复分支仍只能手工复现
- 控制器/入站家族锁定（external-controller-tls/-unix/-cors/-doh、tuic-server、ss-config/vmess-config、listeners/tunnels、tls 段、allow-lan 与鉴权家族）只回上游源码核对了键名与启动前提、用 buildConfig 实测了剥除，**没用真内核验证过额外监听真的开不出来**；unix socket 文件创建、TUIC/SS/Vmess server bind、`allow-lan: true` 下内核是否真的绑到全网卡等内核侧行为同理。**这不是待办**：主力开发机（Mac mini）按设计不装内核（见「平台实测备忘」末条），要验得换一台装了内核的机器，与 launchd 真实启停、TUN 提权同属「只能在别的机器上手工复现」那一类。剥除行为本身由 config.spec 全覆盖，内核侧只是第二道确认
- **锁定清单的完整性此前靠人肉对表，v4.13.0 起有了半自动兜底**：`config-inbound-snapshot.spec.ts` 冻结了一份带上游版本号的 `config.Inbound` 字段集，差集必须逐项写明放行理由，否则测试红。**但快照发现不了上游新增字段**——上游加了新入站键，这里不会红，照样漏；它只把「凭记忆重新推导整张清单」降级成「拿结构体 diff 一份已存在的清单」。内核大版本升级时必须人工刷新快照（CLAUDE.md 已记）。历史：redir/tproxy（4.9.0）、-tls/-unix/-doh 与 tuic-server（4.9.1）、ss-config/vmess-config（4.9.2）、listeners/tunnels（4.12.0）、allow-lan 与鉴权家族（4.13.0）**五轮各漏一批**，每轮都以为「这次逐个核对过了」——第五轮漏的那批还是「曾被写进注释提醒别当兜底、却始终没锁它自己」的键
- **锁 `authentication` 的代价（v4.13.0 引入，待观察）**：剥除来源盲，故用户也不能再用覆写给 Mixed 端口设代理鉴权。缓解是 `allow-lan` 已强制 false、Mixed 只监听回环，主要威胁面（局域网）已消失；残余是同机其他进程（含浏览器网页），与控制器默认无鉴权同一量级。控制器侧有 `controller_secret` 逃生口，Mixed 侧暂无——真有人需要再加 settings 键，不提前造开口
- `iptables`、`inbound-tfo`、`inbound-mptcp` 仍原样进运行配置：前者是 Linux 专用的系统集成开关、非监听，darwin 内核无该路径；后两者是 TFO/MPTCP 传输层 socket 选项，不开监听、不改绑定地址、不绕鉴权。config.spec 有用例锁住现状，决策改变时会明确失败而不是悄悄漂移
- 锁定告警只对覆写文件：覆写经操作符设置锁定键（如 `+secret`）已覆盖，但覆写文件内 `match:` 块之后、且文件解析失败被 warn 跳过时不会有告警（文件整体没生效，合理）
- 订阅名 glob 用双指针贪心回溯而非正则，最坏 O(n×m)。**这条是复审时实测推翻前一版结论才改的**：初版「转义成正则再 test」，文档里写的是「`*` 折叠故无嵌套回溯 + 订阅名限长 64，可接受」——实测 `*a`×20 配 64 个 `a` 要跑 70 秒，即长度上限之内的合法输入就能把 CLI 挂死。教训是「输入面受控」不能替代实测：覆写文件确实是用户自己写的，但把自己写挂且毫无提示，与本仓「宁可报错也不静默失效」的取向相悖。新实现与旧正则版做过 30 万组差分测试（name 限 SAFE_NAME_RE 字符集）结果全一致，同一组恶意输入 0ms；spec 里那条用例带耗时断言（<1s），反向验证：换回正则版后整个测试文件跑不完（60s 超时）
- 单个覆写文件的 `enabled` 写错会让 `mihomo status`、`ow` 整体失败（经 `listOverwriteFile` → `loadOverwriteFile` 抛 CliError）。与 `match` 写错的现有行为一致、不是新退化，可接受的前提是错误消息带文件名（已有用例锁住）
- 元数据键的操作符拦截覆盖 `parseOverrideKey` 能识别的全部形态，**含尖括号转义**：`<enabled>` 同样报错（实测）。代价是失去了「写一个真名为 `enabled` 的配置键」的逃生口——mihomo 顶层目前没有这个键，故暂无影响；若上游将来新增，需要在 `assertNoMetadataKeyLookalikes` 里为尖括号形态开一个口子
- `kickstart -k` 超时 60s 远超锁的 10s 强夺阈值，必须留在锁外，故它与并发 bootout 的交错无法用锁串行化；现在只保证「不再 re-enable/re-bootstrap」与「不再把用户的 stop 报成内核故障」，不是把这个交错消掉了
- 锁内 launchctl 调用有持锁预算（最坏总时长 < `LOCK_STALE_MS`）：start 侧 enable+bootstrap 两次默认 5s、恰好等于阈值，是既有基线（startService/installService 本就如此），不因本轮变化；stop 侧 bootout+disable+复核共三次，单次 `SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS`（3s，合计 9s），别再往任何锁内加东西。锁内三环节（复核先于递增、递增在锁内、bootout 与 disable 同锁）谁也挪不出锁，缩减调用次数的路走不通，理由见 service.ts 该常量注释
- 停止计数是多写者读-改-写且刻意不加锁：极端交错下可能用较小值覆盖较大值，使某条后续命令偶发判为「变了」而中止。判据是 `!==` 本就偏保守，接受之
- `cmdStop` 路径 (b) 的「记录必须在 handleStopResult 之后」只由代码位置与注释保证：非 root 下无法让 SIGKILL 失败，测不出来
- settings/cache 写入有锁，但 reset 的跨文件删除不是事务；未承诺与下载、另一次 reset 并行时整个目录原子切换
- 测试只依赖 macOS 自带命令（bash/launchctl/pgrep/pkill/lsof/gh）与 node 自身（bash 仅作桩脚本的 shebang）。doctor 的计时桩一度用 `python3` 取毫秒（`date` 不支持 `%3N`），是全仓唯一的外部依赖孤例，已改用 `process.execPath -e "Date.now()"`——跑测试的解释器必然在，路径也确定。新增测试桩需要取时间/做计算时照此办理，别再引第二个运行时
- `config` 命令不做内核校验，故它能输出「形态合法但内核会拒绝」的配置（例如引用了不存在的节点）。这是刻意的分工——校验归 `doctor` 与 `start`，只读展示不该要求装了内核
- sudo 三处收口（超时 60s、退出码分工、残留清理 CliError）的完整链路只能真机 sudo 验证：慢密码场景、bootout 真实失败的 exit 3 渲染、四个命令下的实际终端输出；包装决策已纯函数化测试
- `restartService` 的 copy-truncate 路径中 `allocateArchivePath()` 在 best-effort try 之外：同秒已存在 1001 个归档（序号耗尽）时 CliError 会穿出而非被吞。病态场景，接受之；动这段时别顺手「修」进 try——归档名拿不到时轮转整体跳过是更合理的语义
- TUN 运行中 `sub use`/`ow` 的按原模式重启与更新提示（`start tun`）已修，但真实 TUN 提权流程的端到端（sudo 弹窗、路由切换、恢复）未复测，仅经 runtime.spec 的桩内核路径验证决策
- 本轮深审其余未修的低危项：`unhandledRejection`/`uncaughtException` 已统一口径但渲染函数本身不可注入测试；`NO_COLOR`/stderr 设色经 pty 手工验证、无自动化；clearProxyEnv 对企业 env 代理网络的影响已文档化（CLAUDE）但无提示机制。`npm_config_proxy` 等 npm 专属代理变量未清——npm 读 npmrc 不依赖该 env、gh/curl 不识别，不构成下载死锁，保持现状
- 4.9.0 复审记录但未修（判定接受或不可自动化）：`FORCE_COLOR` 不支持、`TERM=dumb` 仍出色；无 `--` 结束选项约定（当前无需要它的入口，订阅名已禁止 `-` 开头）；gh 资产名未拦前导 `-`（仅 GitHub API 被篡改时可达）；代理探测 curl 未加 `--proto =https`（只看 204 无机密）

## 已评估未采纳

- **全局 `--verbose`**：输出散在 24 个模块的 265 处直接 `console.*`，无中心化日志层；且选项按命令白名单校验（`assertKnownFlags`，14 处），全局开关要么加满 14 个白名单、要么在 index 集中剥离——横切改动大而收益不明。排查已有三条路径：`doctor`（体检加修复指引）、`logs`、`status --json`。真要做，先建日志层再谈开关

## 自动化测试边界

真实 sudo/TUN 会修改路由、需要密码并可能留下 root 属主文件，开发机和 CI 不自动执行

完整服务启停测试也不默认运行：enable/disable 会在 `/var/db/com.apple.xpc.launchd/disabled<uid>.plist` 给每个临时 label 留永久记录，launchctl 无清除动词；只用 bootstrap/bootout 的一次性 label 可以临时验证有限的 launchd 行为，但不能覆盖 stop 的全部语义。要驱动服务层的 launchctl 路径时用 PATH 前置的桩 launchctl（service-concurrency.spec 的做法）：代码走真实路径、真实 launchd 一点不被碰，配 HOME/MIHOMO_CLI_DIR/一次性 label 三层隔离

进程与 reset 测试必须验证隔离前提：临时 MIHOMO_CLI_DIR 限定进程路径，独立 MIHOMO_CLI_DAEMON_LABEL 限定 plist/服务查询；仅隔离数据目录不足以保护用户服务

## 平台实测备忘

- kickstart -k 可能阻塞超过 5s，当前使用独立的 60s 超时；bootout 未装载目标返回 3
- KeepAlive.PathState 只决定退出后是否重启，删除标志文件不会主动停止进程，不能用来替代 stop
- disabled 位独立于 plist 持久化，enable 也留记录；手工移除需 sudo plutil，keypath 的点须转义，磁盘修改要重启后才与 launchd 内存一致，不能做进 CLI 自动清理
- BSD ps command 列需 -ww，stat 用 -f%z；open 是异步桌面操作，返回后才可能失败，调用方保留手动路径
- 未装内核的开发机是正常环境，不能为了检查自动安装用户服务或提权；真机结论可能来自其他测试机器

## 文档与流程复盘

稳定约束集中在 CLAUDE，历史保留在 CHANGELOG/git

v4.9.2 的教训是关于本文自身：**「已核对」的记述会被后人当成已核对，从而关掉这条线索**。v4.9.1 写下「键名逐个回上游 General 段核对」时并未真正遍历 `Inbound` 字段集，而这句话此后成了不必重查的理由。此类声明要落到可复现的对表方法（照哪个结构体、哪个函数的入参），不写「逐个核对过」这种无法复核的完成态；写完再回头验一遍声明本身是否属实

发布后也要回头改状态：v4.9.1 发布后本文仍留着「待发布」和旧的测试数（596，`d4eb38b` 补 3 条后没同步），两处都在 v4.9.2 修正。release 流程第 14 项要求同步本文档，实际漏的是**发布动作完成之后**那次状态更新。

**v4.12.0 又漏了同一处**——发布八步全走完（npm / tag / Release 俱全）、还从 registry 拉回产物验过六项行为，唯独本文头部仍写着「未发布」。同一条教训两次栽在同一个位置，说明「记在复盘里」不够：它不在发布清单上，就不会被执行。故 release 流程新增**发布后收尾**一节（改本文状态行 + 核对计数），把它变成一个有勾可打的步骤而不是一句提醒。写在这里的教训，如果对应一个具体动作，就该同时落进清单。

v4.10.0 的教训是**测法本身也要验**：用 `mihomo config tun` 去测 TUN 模式下元数据是否泄漏，但 `config` 不接受模式参数——命令其实报了参数错误，「0 条泄漏」只是因为压根没输出配置。同一轮里还拿订阅自带的节点名 `TW Fixed IP` 当 e2e 探针（真实订阅里出现 5 次，断言恒真）。两次都是**假阳性**：测试跑绿了，但绿的原因不是被测功能。手工验证一个「没发现问题」的结论时，先确认该测法在功能坏掉时会红——与本仓对自动化用例的反向验证要求同一条纪律，手工验证不该豁免

类型检查曾漏掉测试字符串内对已删除导出的引用，已修正并把全仓搜索要求写入 CLAUDE；发布流程的注册表示例也同步去掉了失效字段

v4.12.0 的教训是**「待定」不是中间状态，在实现上等于放行**：`listeners`/`tunnels` 从 v4.9.0 起被记为「未定的产品决策，两者须一起评估」，此后三轮补漏（-tls/-unix/-doh/tuic → ss/vmess）每轮都逐个核对入站面，却因为这两个键**已经有归档结论**而跳过——「待评估」的标签让它们看起来是被处理过的，实际是三个版本里订阅想写就写。config.spec 那条「待定入站面」用例更强化了这种错觉：它锁的是「原样保留」，跑绿只说明现状没漂移，不说明现状是对的。教训有二：① 安全边界上不留「待定」，要么锁要么写明「刻意放行 + 理由」（`iptables` 就是后者）；② **锁住现状的用例不等于验证过现状**——写这类用例时要在注释里说清它锁的是决策还是正确性

同一轮另两处（status 把主文件显示成 `yaml`、提示指向不存在的 `kernel --help`）都是**只读一遍代码看不出、跑一次就现形**的问题，且都落在刚被重点打磨过的区域（v4.10/4.11 两轮改的正是覆写展示）。复审时除了读代码，把主要命令在隔离数据目录里实跑一遍，成本极低

**本轮（v4.13.0）的教训是「反向验证的预测错了，比预测对更有价值」**：计划里写「把 `allow-lan` 塞回 `BASE_CONFIG` 应转红」，实测 700 条全绿。原因是 `systemConfig` 的赋值无条件，BASE_CONFIG 里那份直接成了**死配置**——既不报错，也无任何行为差异。如果当初只按计划「确认它红」就收工，这个静默的死配置会留在表里，下一个人读到 `BASE_CONFIG` 里的 `allow-lan: false` 会以为它生效。教训有二：① **反向验证要真跑，不能因为「理应会红」就跳过**——预测落空处往往正是认知与实现的偏差点；② 死配置比缺陷更难发现（缺陷会报错，死配置什么都不说），发现后应补不变量用例把它挡在结构层，而不只是改掉当前这一处。现由 `config-inbound-snapshot.spec.ts` 断言两表无交集

**同一轮还有一处「五轮漏键」的新形态**：`allow-lan`/`bind-address` 早在 v4.9.2 就被写进注释和测试名（「别拿 allow-lan 当兜底」），却从没人问过「那它自己锁了吗」。**被写进防线说明里的键，看起来就像已经被防线覆盖了**——这与上一轮「待定标签让人以为处理过」是同构的错觉，只是载体从归档结论换成了注释。核对锁定表时，注释里出现过的键名不能当作已覆盖的证据，唯一证据是它在不在 `LOCKED_CONFIG_KEYS` 里

**删测试时数用例不能 grep 源码，要跑删除前的基线。** 本轮核对「700 删了多少条」时，静态数 `it(` 模板得到 completion.spec 21、completion-install.spec 21，加上 tar 4、位置参数 5，算出来的总数对不上实跑的 643——前者的用例在 `for (const shell of …)` 循环里展开，21 个模板运行时是 25 条（子代理报的 26 同样是数出来的错数）。最终用临时 worktree  checkout 基线逐个 spec 跑 `ℹ tests` 才核准 -57 的拆账（另含被静态盘点整体漏掉的 utils.spec 镜像用例 2 条）。与发布流程核对测试数同一条纪律：计数只认真实运行结果。

**隔离不是只隔离 `MIHOMO_CLI_DIR`。** 落盘位置经 `os.homedir()` 推导的东西（LaunchAgent plist 在 `~/Library/LaunchAgents`），数据目录变量挡不住，还需把 **`HOME`** 指向临时目录——service-concurrency.spec 的热重载场景就是三层隔离（`MIHOMO_CLI_DIR` + 一次性 label + 临时 HOME）。手工验证涉及 plist 的路径时同样要做，别只设数据目录变量
