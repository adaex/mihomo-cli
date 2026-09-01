# Changelog

## [3.9.0] - 2026-09-01

ssh 隧道功能的一次结构整理：命令名统一，配置文件脱离覆写机制，顺带修掉一个静默失效的端口漂移 bug。

### 破坏性变更

升级后需手工处理三件事（CLI 会在检测到旧数据时打印提示）：

- **命令 `tunnel` 改为 `ssh`**，`tunnel`/`tunnels` 别名一并删除，`--no-tunnel` 选项改为 `--no-ssh`。`reset` 目标同样只认 `ssh`
- **`settings.json` 的 `tunnels` 字段改为 `ssh`**，不迁移、不双读。旧字段会残留在文件里但永不被读取，**隧道需重新 `mihomo ssh add`**
- **配置文件 `overwrite.tunnel-<名字>.yaml` 改为 `ssh.<名字>.yaml`**，且其中**不再需要（也不应该）声明 socks5 节点**——节点已由 CLI 内建注入。迁移时把分流规则挪到新文件、把分组名从 `Tunnel-<名字>` 改为 `Ssh-<名字>`，然后删掉旧文件。旧文件若留着会被覆写机制继续加载、注入一份重复节点，`mihomo start` 与 `mihomo ssh` 都会对此告警

隧道运行态目录从 `tunnel/` 迁至 `ssh/`。旧目录里记录的 ssh 进程升级后会失联（继续占着端口而 CLI 停不掉），故新版本首次运行时会**自动停掉它们并删除旧目录**（带命令行校验，不误杀 PID 复用的无关进程）。

### 修复

- **改端口后静默失效（隐性数据 bug）** - 隧道有两份真相：`settings.json` 里的 host/port，和用户维护的覆写文件里手写的 socks5 节点。CLI 只写前者。于是 `tunnel rm work` 后再 `tunnel add work --port 1081`，因覆写文件已存在而不重建，配置里的节点仍指向 1080——隧道监听在新端口，mihomo 往旧端口送流量，**全程无任何提示**

  修法是取消「节点写在用户文件里」这个前提：节点改由 CLI 依据 settings 合成注入，端口从此只有一个真相。`ssh add` 现在也恒触发重启（此前只在新建模板时重启，改端口那次正好漏掉）

- **`ow off` 会连带断掉内网分流** - 覆写是可选调优，内网出口是刚需，前者关掉不该让后者失效。此前隧道节点住在覆写文件里，`ow off` 会让它们整批从配置里消失，而 ssh 进程照常跑着，无任何提示。现在 ssh 配置走独立管线，不看覆写开关

- **同名节点冲突时用户文件可覆盖安全约束** - `~proxies` 是字段级合并且后合并者胜，此前字母序更靠后的覆写文件能改掉隧道节点的 `server`/`port`（`docs/ssh-requirement.md` 的「实现记录 2」已记载该局限）。现在 CLI 注入恒排在所有用户文件之后，手写同名节点改不掉端口，也绕不过 `127.0.0.1` 绑定

- **`reset --full` 会留下 ssh 配置文件** - 新的 `ssh.*.yaml` 既不归 `overwrites` 目标管，旧 ssh 目标又只删运行态，「删全部」名不副实。现 `reset ssh` / `reset --full` 一并删除；单条 `ssh rm` 仍保留该文件（里面有用户手写的分流规则）

### 变更

- `src/tunnel.ts` 拆为 `src/ssh.ts`（进程侧）与 `src/ssh-config.ts`（配置侧）。拆分是硬性要求：`config.ts` 需调用配置侧，而进程侧依赖 `process.ts`、后者又依赖 `config.ts`，不拆就是循环依赖
- 隧道列表读取 `getSshTunnels` 下沉到 `settings.ts`，与 `getSubscriptions` 对齐
- 新增分阶段调试文件 `runtime/4.ssh.yaml`（ssh 层的合并输入，含 CLI 注入的节点）。不并入 `2.overwrite.yaml`——那会让 `ow off` 时的调试输出自相矛盾
- 日志文件 `logs/tunnel-<名字>.log` 改为 `logs/ssh-<名字>.log`
- `ssh` 列表现在显示每条隧道的配置文件路径

### 测试

- 单测 165 → 185：新增 `ssh-config.spec.ts` 20 项，覆盖合并层序（含「用户手写同名节点改不掉 port/server」这条核心不变量）、`ssh.*.yaml` 与 `overwrite.*.yaml` 的双向文件名隔离、注入节点的 include-all 整名锚定排除

## [3.8.1] - 2026-09-01

一轮全量代码审查的修复集：1 项新发现的高危数据丢失，以及上轮审查遗留的 9 项「仍待处理」。全部经实际复现确认，修复后回归验证。

### 修复

- **并发操作会静默丢数据（高危）** - `settings.json` 无跨进程锁，两个 CLI 进程各自读旧全量再写回，后写者把先写者的改动整块抹掉，**而先写者已经打印了「已添加」**。实测 6 个并发 `sub add` 丢 3 条；慢速 `sub add`（跨网络下载）期间执行 `tunnel add`，隧道被抹成 `null`——订阅与隧道同住一个文件，互不相干的命令互相摧毁。触发条件很日常：机场慢时 `sub add` 要跑十几秒，此间在另一个终端做点别的即可

  修法是新增文件锁（`O_EXCL`）把整个「读-改-写」圈起来。仅「写前重读盘」不够——读与写之间仍有窗口，实测仍丢 3 条。持锁超过 10s 视为进程已崩溃并强夺，避免一次崩溃永久锁死后续所有命令

- **内核下载来源未钉死（供应链）** - `--mirror-all` 下连 GitHub API 都走镜像，`browser_download_url` 完全由镜像说了算，而此前对非 github 的 URL 原样放行，镜像返回任意主机地址即可让 CLI 下载任意二进制；该产物随后 `chmod 755` 并在 TUN/daemon 下**以 root 运行**。现加下载 host 白名单 + 强制 https（校验在加镜像前缀之前），curl 补 `--proto '=https' --proto-redir '=https'`（实测 `-L` 会跟着 302 降级到明文 http 并落盘）与 `--max-filesize`，下载后比对 `asset.size`

- **归档 symlink 成员可 chmod 任意文件** - 名为 `mihomo`、指向任意路径的符号链接，其条目名完全合法（不含 `..`、非绝对路径），能通过路径穿越守卫，随后被当成二进制 `chmod 755`——实测把 `chmod 600` 的文件改成了 755。现同时校验条目**类型**（拒符号/硬链接）并把遍历的 `statSync` 改为 `lstatSync`

- **畸形流量响应头会抹掉已有用量数据** - `Subscription-Userinfo` 返回 `garbage` 这类无有效字段的头时，解析结果 `{}` 是 truthy，导致 upload/download/total/expire 四个字段被 `undefined` 覆盖。反直觉的是**没有响应头反而安全**（整块跳过）。另修 `expire=abc` 被塞 0 而显示成「永久有效」（垃圾值朝最误导的方向失败）、`total=1e999` 写成 `null`、负数原样入库使百分比失真

- **时钟偏移导致订阅永不自动更新** - `updated_at` 落在未来（系统时间被改过、跨时区调时）时时间差恒为负，`needsAutoUpdate` 恒 false，订阅静默过期到失联

- **`daemon off` 在 plist 被手动删除后是空操作** - 用户 `sudo rm` 掉 plist 后任务仍处装载状态，此前只看文件存在就直接返回，永不执行 `launchctl bootout`，于是 KeepAlive 继续把内核拉起——杀掉立刻重生，且 CLI 无任何途径卸载。现判据改为「plist 不在**且**无 root 内核在跑」

- **`daemon on` 遗留 root 属主 pid 文件** - 使后续 `daemon off` → `start` 撞上残留检查而拒绝启动，这个死胡同完全由 CLI 自身的 on/off 循环造成

- **热重载信任 9090 上的任意响应** - 该端口被其他服务占用且对 PUT 返回 2xx 时，CLI 打印「已重启 (保活)」而 daemon 内核仍跑旧配置，配置变更静默未生效。现先确认应答方确为 mihomo

- **`tunnel up` 期间 Ctrl+C 泄漏 ssh 进程** - 等待转发建立最长 20 秒，其间中断会留下孤儿 ssh 进程和一份声称健康的运行态文件（实测持久残留、不自愈），随后 `tunnel up` 报「已在运行」而 `status` 报「假活」，自相矛盾。现在该窗口内注册一次性清理，启动成功后立即注销以保持「隧道活过 CLI 退出」的语义

- **`__proto__` 作订阅名时缓存永远写不进** - 该名称通过校验，但在普通对象上赋值是设置原型而非自有属性，落盘为 `{}`，`updated_at` 永远缺失 → 每次 `start` 都重新下载该订阅

- **配置校验的四个静默空洞** - 均无任何告警：proxy 与 proxy-group 同名（两者都留下，mihomo 因重复名拒绝加载）；`use` 引用不存在的 provider（从不校验，且使该组免于删除）；节点池为空 + `include-all` 的空组保留（实际无任何出口）；`proxies` 写成字符串时整体跳过校验、非法结构原样落盘

- **`--mirror` 接受非法 scheme** - 此前用 `startsWith('http')` 判断，放行 `httpfoo://x` 与明文 `http://`，并把 `ftp://e.test` 拼成 `https://ftp://e.test/`。现改用 `URL` 解析 + https 白名单

- **sudo 中间脚本的权限位不重放** - `writeFileSync` 的 `mode` 只在创建新文件时生效，前次崩溃残留的同名文件会保留旧权限（实测 0666 重写后仍是 0666），而该文件下一步就交给 sudo 执行。两处写后补显式 `chmodSync`

### 测试

- 单测 145 → 165：文件锁 6 项（含用真实子进程验证跨进程互斥、陈旧锁强夺、异常路径释放）、`parseUserInfo` 边界 8 项、配置校验空洞 6 项（含「正常配置不产生告警」的回归用例）

## [3.8.0] - 2026-09-01

### 新增

- **ssh 隧道出口（`tunnel` 子命令，别名 `ssh`）** - 管理 `ssh -D` 动态转发进程的生命周期，把可 ssh 登录的机器变成本地 SOCKS5 出口。分流仍交给覆写机制，本功能补的是「隧道断了 mihomo 不知情、会一直往死端口送流量」这一环

  ```bash
  mihomo tunnel add work --host m4 --port 1080
  mihomo tunnel up|down|status [名字]
  mihomo tunnel rm <名字>
  ```

  - **随 `start` 一并拉起**：默认带 `auto` 标记，`start` 顺带启动、`stop` 连带停止（`--no-tunnel` 跳过，`add --no-auto` 不参与）
  - **隧道失败不影响内核启动**：只影响内网分流那部分规则，故仅打印显眼的黄色警告并附上 ssh 给出的原因，其余流量照常
  - **`stop` 只停自己起的**：手动 `tunnel up` 起的隧道带 `manual` 标记，不会被 `mihomo stop` 带走，避免下次 start 又起一个而累积僵尸进程
  - **`status` 真实探测端口**：能识别「进程还在但转发已死」的假活——那正是最误导的形态，此时 mihomo 仍在往死端口送流量
  - **起之前先检测端口占用**，不盲启后失败
  - **`add` 生成覆写模板** `overwrite.tunnel-<名字>.yaml`（已建好 socks5 节点与 select 分组，分流规则留白待填），生成后完全由用户维护，CLI 不再改写，`tunnel rm` 也不删它
  - 新增 `reset tunnel` 目标（先停进程再删运行态，反序会导致 ssh 进程失联且再也停不掉）

  安全边界：`-D` 恒绑 `127.0.0.1` 且不提供绑定地址开关（绑 `0.0.0.0` 会让同一 WiFi 下任何设备经本机进内网）；`--host` 拒绝 `-` 开头的值（`-oProxyCommand=...` 等同任意命令执行）；ssh 参数固定带 `ExitOnForwardFailure`/`BatchMode`/`ConnectTimeout`/`ServerAlive*`

  暂不做自动重连保活：断线依靠 `ServerAliveInterval` 让进程自退，再用 `tunnel status` 查出来

### 修复

- **`reset --full` 会留下空的 `settings.json`** - 新增的 `tunnel` 目标其 `onAfter` 会 `writeSettings` 清空隧道列表，若排在 `settings` 之后就会把刚删掉的文件重建成 `{}`，与「已重置: 设置」矛盾。现移到 `settings` 之前（与 `subs` 同理），并加单测锁定该顺序约束——这是 v3.7.0 已修过一次的同类问题（当时是参数顺序），换个目标又复发了

## [3.7.0] - 2026-08-22

### 修复

- **错误响应体绕过大小上限，可致 OOM** - `!response.ok` 分支直接 `await response.json()`，不经流式大小检查。实测 60MB 错误体使客户端 RSS 增长 303MB——攻击者只需返回非 2xx 即可绕过 50MB 防护。现错误体限量 64KB 读取（仅用于诊断），修后 RSS 增长 9MB
- **机场返回错误 JSON 会覆盖磁盘上可用的订阅** - 下载后只要内容能解析成对象就原子覆盖写盘。机场返回 `{"error":"quota exceeded"}` 之类响应时报「已更新 (0 节点)」，把原本可用的订阅**不可恢复地覆盖**，随后 mihomo 带零节点启动导致断网；且这在 `start` 的自动更新路径上，用户无操作即触发。现写盘前要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空，并提取服务端错误信息作为提示
- **`ps` 输出截断致测速实例泄漏并占用端口** - `isProcessCommandMatching` 未带 `-ww`，BSD/macOS 的 `ps` 即使 stdout 非终端也把 command 列截断到 79 列。测速实例的匹配串（`test/runtime/config.yaml`）起始偏移随用户名增长（`alice` 为 80、`jonathan.smith` 为 98），常见家目录下均越界 → 匹配恒失败 → `stopTestInstance` 跳过 SIGKILL 却仍删 pid 文件，内核残留占着 27890/29090 且再无记录，下次 `sub test` 直接启动失败
- **`sub add` 失败时劫持当前活跃订阅** - `setDefaultSubscription` 在下载之前执行，回滚时 `removeSubscription` 把活跃订阅落到列表首项而非用户原选择。复现：活跃为 `work`、列表为 `[airport-a, work]`，添加一个不可达 URL 失败后活跃变成 `airport-a`，下次 `start` 静默连错机场。现切换移到下载成功之后
- **`MIHOMO_CLI_DAEMON_LABEL` 未校验导致 root 任意路径写** - 该值经 `path.join` 拼成 plist 路径后，是 `sudo install -m 644 -o root` 的写入目标与 `sudo rm -f` 的删除目标，而 `path.join` 会折叠 `..`（`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），内容还部分可控。现加字符集校验：非法值回退默认标签，并在 `enableDaemon`/`disableDaemon` 入口报错
- **覆写注入节点的 `exclude-filter` 误排除同前缀节点** - mihomo 的 `exclude-filter` 是无锚点正则搜索。注入名为 `HK` 的节点后，订阅里的 `HK-01`/`HK-02` 全被踢出 `include-all` 分组。现改为 `^(?:...)$` 整名锚定
- **覆写 YAML 笔误抛裸 `TypeError` 并打印堆栈** - `validateConfig` 的类型断言无校验，四种常见笔误会崩溃：`proxies` 含空列表项、`rules` 漏写 `-` 成标量、`proxy-groups` 写成映射、`rules` 含非字符串。用户配置错误被当成程序 bug。现全部转为带修正提示的 `CliError`
- **`~key`/`+key` 作用于非数组时静默损坏配置** - 静默包成单元素数组：`~dns: {enable: true}` 把映射 `dns` 变成 `[{enable: true}]` 并丢掉原有字段，而 mihomo 要求 `dns` 是映射；`log-level+: debug` → `["debug"]` 同理。现报错并提示改用 `key!` 或直接写 `key`；目标不存在时仍放行（新增数组的正常用法）
- **`maskUrl` 逗号切分致 token 明文泄漏** - 无条件按逗号切分，`?nodes=us,hk&token=SECRET` 被劈开后两段都识别不出 token 参数，密钥明文输出。同一根因还让 query 含逗号的合法单 URL（`?flag=clash,meta`）被误判多源、`sub add` 报「无效的 URL」而无法添加。现统一判据为「切分后每段都是合法 http(s) URL 且不止一段」
- **`settings.json` 为合法 JSON 但非对象时绕过损坏恢复** - `null`/`[]`/`123`/`"hi"` 都直接进缓存，不备份不告警：`null` 让 `getSubscriptions()` 抛裸 `TypeError` 且缓存判定恒失效，字符串被展开成 `{"0":"h","1":"i",...}`。现一并走备份+回退分支
- **`subscriptions` 非数组时被按字符展开** - 手改成 `"oops"` 后 `addSubscription` 写出 `["o","o","p","s",{...}]` 且不报错。现在唯一读取入口 `getSubscriptions()` 收口校验，并滤掉缺 name/url 的残缺条目
- **`reset` 忽略停止进程的结果** - root 实例（TUN）下走 `sudo pkill`，用户取消密码时失败的 pid 被静默丢弃，仍继续删除数据，留下孤儿 root 进程跑在已删配置上。现删数据前复查并中止
- **`reset --full` 残留含密钥的备份文件** - `settings.json.bak`（损坏恢复时生成）带 `controller_secret` 与订阅 token 明文留下，与「已重置: 设置」矛盾。现纳入删除路径
- **`reset` 结果依赖参数顺序** - `subs` 目标的后置钩子会重建 `settings.json`，故 `reset settings subs` 留下 `{}` 而 `reset subs settings` 才真删。现按注册表顺序执行
- **`match` 的订阅名匹配与 `sub use` 口径不一致** - `sub use home` 能切到订阅 `Home`（模糊匹配大小写不敏感），但 `match: {subscription: home}` 精确比对匹配不上。现统一为大小写不敏感
- **`parseIntArg` 接受危险值** - 无范围校验：`-j 0` 让测速起 0 个 worker、结果全空洞、被报成「所有节点失败」（伪造结果）；`-t 5s` 静默取 5ms 让全部节点超时。现非正整数一律报错，并把 `test`/`clean` 的参数校验移到运行状态检查之前
- **合并订阅的错误指向被连带取消的 URL** - 任一 URL 失败即中断其余请求，按顺序取第一个错误报出的往往是被取消的那条，真正的 403/token 过期被隐藏。现优先报非取消类错误
- **`dir` 子命令的错误绕过统一渲染** - `cmdDirectory` 用 `void` 丢弃 async 分发的 Promise，`dir open <未知目标>` 抛的错误退化成「未处理的 Promise 拒绝」，丢掉标签颜色与可用目标列表
- **`ow`/`dir` 未知子命令静默回落** - `ow onn` 静默打印列表且退出码 0（对比 `sub adz` 会报错并给纠错建议）。现补齐纠错提示
- **测速实例的 pid 记录时机存在泄漏窗口** - spawn 与写 pid 文件之间被 Ctrl+C 中断时，只认 pid 文件的清理逻辑会漏掉 detached 子进程。现增加内存记录作为第二来源
- **`reset` 保活取消路径退出码为 0** - `console.error` + `return` 使「重置中止」被脚本误判成功，且绕过统一渲染
- **`mihomo on`/`off` 丢弃启动选项** - 唯二不透传后续参数的快捷命令，`mihomo on -s` 静默吞掉 `-s`，而 README 声明其与 `ow on` 等价
- **`restartDaemon` 抛裸 `Error`** - 最后一处未迁移的数据层预期错误

### 新增

- **平台守卫** - `package.json` 声明 `"os": ["darwin"]`，`main()` 开头校验平台（豁免 `help`/`version`，`MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 为开发逃生阀）。此前非 macOS 上是「部分成功」：`status`/`sub` 看着正常，`daemon on` 输完 root 密码才撞 `/Library/LaunchDaemons`，`ui` 报告成功却什么都没打开（`open` 命令缺失被吞掉，且 Debian 的 `open` 指向 `run-mailcap` 会把 URL 当附件处理）。守卫先于目录创建，避免在不支持的平台留下数据目录
- **`sub remove` 模糊匹配需确认** - 精确名称直接删除；模糊命中时展示完整名称并要求确认（`-y`/`--yes` 跳过）。此前 `sub remove air` 会无提示删掉 `production-airport`
- **`subs` 别名** - 与 `directory` 的 `dirs` 对称，落地命名规范的「简写复数」档
- **GitHub Actions CI** - 在 `macos-latest` 上跑 typecheck / lint / test / build
- **`prepublishOnly` 钩子** - `dist/` 被 gitignore 且此前无发布钩子，漏跑构建即发布陈旧或缺失产物

### 变更

- **破坏性操作在非交互环境报错而非静默取消** - `reset`（无 `-y`）与 `sub remove`（模糊匹配）在管道/CI 下此前打印「已取消」并退出 0，脚本会误判操作已完成。现报错退出 1 并提示加 `-y` 或用完整名称
- **`confirmPrompt` 收敛到 `commands/shared.ts`** 并增加 TTY 守卫（此前在非交互环境会挂住等输入）

### 内部

- **单测从 55 增至 101** - 新增覆盖：配置形态校验、`exclude-filter` 锚定、覆写数组语义误用、`match` 大小写、`parseIntArg` 边界、多源 URL 逗号判据
- **`CODE_REVIEW.md` 重写** - 上一轮（v2.9.x 基线）的「仍待处理」清单已逐项复核：#12/#14 实际已修复，#10 的后果比原描述严重（是 token 泄漏而非仅显示切碎），#17 的建议不可行——上游 v1.19.30 的 127 个资产中零 checksum 文件，故真实缺口是下载地址的 host 未钉死。新增 9 项待处理（tar symlink 致任意文件 chmod 755、热重载信任任意 9090 响应、`Subscription-Userinfo` 边界等）
- **`README.md` / `CLAUDE.md` 校正** - 平台说明从「Windows / Linux 正在适配中」改为「仅支持 macOS」（此前无对应代码）；覆写实为默认启用（此前文档教用户先 `ow on`）；`log -o` 是系统默认程序而非编辑器；补齐 `logs current`、长选项、`reset`/`dir open` 完整目标列表、分阶段调试文件；新增「选项写法」「数据保护」两节

## [3.6.0] - 2026-08-15

### 修复

- **`sub add` 重名时误删既有同名订阅** - 回滚逻辑包住了入库步骤，添加重名订阅时「已存在」错误同样触发 `removeSubscription`，把用户既有的同名订阅（含缓存与配置文件）删掉。现入库移出 try 块，回滚仅覆盖「入库成功后下载失败」
- **`start` 拼错模式名静默按 Mixed 启动** - `mihomo start tn` 之类只判 `=== 'tun'`，拼错不报错，用户会误以为已切到 TUN。现校验模式参数并报错，参数校验先于内核/订阅环境检查
- **pidFile 运行判定可被 PID 复用欺骗** - 只检查 pid 存活，系统重启后残留 pid 文件里的 pid 可能已被无关进程复用，被误判成运行中的 mihomo。现同时校验进程命令行包含内核路径（与测速实例防护同口径）
- **数据层预期错误打印堆栈** - 订阅名称非法/重名、未找到订阅配置、无有效节点、内核/配置缺失等用户可见的预期错误仍抛裸 `Error`，经统一收口后打印堆栈。现全部迁移为 `CliError`

### 新增

- **did-you-mean 纠错** - 未知命令与 `sub`/`daemon` 未知子命令按前缀 + 编辑距离给出纠错建议（如 `mihomo strt` -> `是否想输入: start / stop?`）
- **`update` 更新前检查最新版** - 先查 npm registry，已是最新版本则跳过重装；查询失败（15s 超时）降级为直接安装
- **`status` 显示订阅流量与到期** - 复用订阅缓存的响应头数据，有则展示
- **场景化提醒** - `ui` 在 mihomo 未运行时提示先启动；`kernel` 更新成功后运行中实例提示需重启生效

### 内部

- **utils 按职责拆分** - `colors.ts`（颜色）、`errors.ts`（CliError/TimeoutError/withTimeout）、`http.ts`（HTTP 客户端）独立成模块；`isProcess*` 进程探测归入 `process.ts`，`isProxyValid` 归入其唯一消费者 `test-instance.ts`；`VERSION`/`PKG_NAME` 移入 `constants.ts`。`utils.ts` 只留无副作用的纯函数（sleep、转义、格式化、flag 解析、纠错建议）
- **补充单元测试** - 新增 `suggestSimilar`（did-you-mean）单测，总计 55 个

## [3.5.0] - 2026-08-15

### 变更

- **统一错误处理机制** - 命令层与数据层的预期错误改为抛出领域错误 `CliError`，由入口 `main().catch` 单点渲染（错误前缀 + 多行提示 + 退出码）并执行清理。此前命令层散落几十处 `console.error + process.exit`，错误从不冒泡到统一收口、可能绕过退出前清理。现仅信号处理器与日志 `tail` 事件回调保留直接退出（进程生命周期末端，无法收口）。所有错误前缀统一为红色（`NO_COLOR`/非 TTY 下自动降级为纯文本），动词化提示（如「配置错误」「启用保活失败」）予以保留
- **数据层去除 UI 副作用** - `pickSingleSubscription` 等数据层函数不再直接打印和退出进程，改为抛错由命令层收口，函数返回类型恢复诚实、可复用

### 内部

- **命令子命令分发同构化** - `subscription`/`overwrite`/`directory`/`daemon` 的手写 `if (action === ...)` 分支链改为与顶层命令注册表同构的表驱动分发（`dispatchSubcommand` + 子命令表），并抽取 `requireRunning`/`restartToApply`/`requireActiveSubscription`/`resolveSubscription` 等公共 helper 消除重复。命令行为、帮助输出与退出码均无变化
- **补充单元测试** - 为覆写合并（`parseOverrideKey`/`deepMergeWithOverrides`/作用域匹配）、配置校验（级联删除/规则目标）、节点名归一化、URL 遮蔽等高危纯函数补充 49 个单测，使用 Node 内置 `node:test` 经 tsx 运行，零新增依赖（`npm test`）

## [3.4.0] - 2026-08-15

### 修复

- **配置 `controller_secret` 后测速与热重载失效** - 访问 external-controller 的 HTTP 客户端从不发送 `Authorization`，设置密钥后 `test`/`clean`（走主实例）所有节点返回 401 被判失败，保活的配置热重载也恒 401 回退到 sudo 重启。现测速（主实例）与热重载请求均携带 `Bearer <secret>`；隔离测速实例自身无密钥，不受影响
- **并行更新订阅时缓存临时文件互相踩踏** - `atomicWriteFileSync` 的临时文件名仅含 pid，同进程 `Promise.all` 并行更新多个订阅时写向同名临时文件，导致内容交错或 `rename` 失败。临时名改为 pid + 进程内自增序号，各写入落到独立临时文件

### 安全

- **YAML 别名炸弹 DoS 防护（回归修复）** - 解析订阅/覆写/运行时配置的 `yaml.load` 未设别名上限，js-yaml 默认无限制，恶意配置可借指数级别名膨胀耗尽内存/CPU。现统一设 `maxAliases` 上限
- **序列化对歧义标量加引号** - 配置序列化改用会给 `on`/`off`/`yes`/`no` 等歧义标量加引号的默认 schema。此前裸输出的 `name: on` 虽被 mihomo（go-yaml v3）读作字符串，但流经 PyYAML 等 YAML 1.1 工具会被误解析为布尔，造成静默的配置损坏
- **内核下载文件名路径穿越防护** - 下载内核时临时路径直接拼接 GitHub API 返回的 asset 名，被篡改的响应/镜像可借 `../` 写出内核目录之外。现用 `basename` 剥离目录成分
- **`open` 命令 URL 参数注入防护** - 打开订阅页面/日志文件时，服务器可控的 URL（订阅响应头 `web_page_url`）若以 `-` 开头会被 `open` 当作选项。现加 `--` 终止选项解析
- **测速实例终止前校验进程身份** - 停止隔离测速实例时按 pid 文件裸值 `SIGKILL`，pid 被系统复用后可能误杀无关进程。现杀进程前校验其命令行确属该测速实例

### 变更

- **覆写 `~proxies` 注入的节点纳入 include-all 排除** - `~key` 就地合并在同名节点不存在时会追加新节点，此前只有 `+proxies`/`proxies+` 注入的节点会从 `include-all` 分组排除，`~proxies` 追加的节点会被重复纳入。现一并排除
- **依赖升级** - `js-yaml` 5.2.1 → 5.3.0（修复 flow collections 指数解析 DoS）、`esbuild` 经 overrides 提升至 0.28.2（修复 dev server 任意文件读取）、`@types/node` → 26、`@biomejs/biome` → 2.5.8、`lint-staged`/`tsx` 跟随最新；`npm audit` 无告警

## [3.3.0] - 2026-08-15

### 新增

- **覆写按 name 就地 patch 数组元素（`~key` 语法）** - 此前覆写数组只有整体替换（`key!`）、前置（`+key`）、追加（`key+`）三种语义，无法「只改数组里某一个元素的部分字段」。新增 `~key`：以 `name` 为主键匹配数组元素，命中则深度合并该元素、保留其余字段与其余元素，找不到则追加。典型用途：修改订阅下发的某个 `proxy-group` 的字段（如给 `select` 组注入 `default-selected` 改默认选中节点），保留原有全部节点、不动其它分组、订阅更新后依然生效。键名真以 `~` 开头时用 `<~key>` 转义
- **覆写作用域限定（`match` 块）** - 覆写文件顶部可加 `match:` 块，让该文件只对指定订阅生效（无 `match` 仍全局生效，向后兼容）。支持 `subscription`（按订阅名精确匹配）和 `url-domain`（按订阅 URL hostname 后缀匹配）两个条件，所列条件需全部满足（AND），条件值为数组时其内部为 OR。未知匹配键或无法评估的条件均 fail closed（跳过该文件并告警），避免误配置静默全局生效。`ow list` 与 `status` 会展示各文件的作用域

### 修复

- **TUN 启动失败误报"密码错误或取消"** - 启动脚本失败时 `exit 1`，与 sudo 鉴权失败的退出码冲突，配置错误、端口占用等真实失败都被误报。脚本失败改用 `exit 2`，调用方据此区分；失败时同时清理 root 属主 pid 文件，避免后续 `start` 因残留死锁（旧提示只让 `pkill`，清不掉 pid 文件）
- **`reset subs` 半重置状态** - 只删订阅缓存/原始配置文件，settings 里的订阅列表保留，重置后 `start` 报"未找到订阅配置"。现同步清空订阅列表与 `active_subscription`
- **`sub add` 下载失败留下半成品订阅** - 订阅已写入并可能切为默认后下载才失败，之后 `start` 必然报错。现下载失败自动回滚（移除刚添加的订阅）
- **覆写文件顶层为数组时被当配置合并** - YAML 顶层数组能通过类型检查，被解构出数字键参与合并。现拒绝并告警
- **`sub web` 缺页面地址时覆盖已保存配置** - 回退路径重新下载订阅并落盘，副作用超出"打开页面"。现只取响应头，不写盘
- **`clean` 后订阅文件残留死节点规则** - 只清理了引用已删空分组的规则，直接引用死节点的规则留在文件里（靠构建时兜底）。现保存时一并清理
- **自动更新超时后全部计为失败** - 超时即丢弃已完成结果。现收齐已完成/已失败的更新再统计，超时只影响未完成的部分
- **`SUB-RULE` 规则被误删** - 配置校验按「末段为代理/分组名」检查规则目标，但 `SUB-RULE` 末段引用的是 sub-rule 名，被当作无效引用删除。现跳过此类规则的目标校验
- **空名覆写节点清空 include-all 分组** - 覆写注入 `name` 为空的节点时，exclude-filter 正则出现空分支（`a||b`）匹配所有节点，分组被清空。现过滤空/非字符串节点名
- **节点重命名未同步规则** - 保存时裁剪节点名只更新了 `proxies`/`proxy-groups`，规则里直接引用旧名会变悬空引用。现一并 remap `rules` 中的目标
- **`sub add` URL 校验过宽** - 仅判 `startsWith('http')`，`httpfoo://`、`http-evil` 等能通过。现用 `URL` 解析校验协议并 trim 首尾空白
- **`reset -f` 语义误导** - `-f` 是 `--full`（删全部）的别名，与常见 `-f=force` 直觉冲突，且未知标志（如拼错的 `--ful`）被静默忽略后走默认删除。现移除 `-f` 别名（删全部只认 `--full`，免确认统一 `-y/--yes`），未知标志一律报错退出
- **HTTP 下载无响应体大小上限** - 订阅/内核下载被劫持或故障返回超大响应时可能 OOM。现按 `Content-Length` 提前拒绝并流式读取，超 50MB 中止
- **`tar` 解压无路径穿越防护** - 恶意镜像可借含 `../`/绝对路径的归档条目写出目标目录之外。现解压前校验条目路径
- **内核进程创建失败处理** - 内核二进制不可执行时，`spawn` 的 error 事件无监听会冒泡为未捕获异常、`pid` 缺失会二次抛错。现监听 error 并在 pid 缺失时给出可读提示

### 安全

- **错误信息遮蔽路径型订阅令牌** - `maskUrl` 原仅遮蔽 query/userinfo，形如 `/subscribe/<TOKEN>` 的路径令牌会原样出现在错误日志。现对疑似令牌的长路径段一并遮蔽
- **`ui` 命令不再明文回显 `controller_secret`** - 改为提示密钥已配置、见 `settings.json`，避免进入 shell 历史/日志

### 变更

- **`allow-lan` 不再强制锁定** - 订阅/覆写显式提供时按其值（支持局域网设备连入代理端口的入站场景），未提供时默认 `false`
- **`sub` 列表改为纯只读** - 不再触发自动更新（更新是写操作），`sub add`/`use`/`update` 末尾的列表也不再顺带更新其他订阅。自动更新只在 `start` 与显式 `sub update` 时发生
- **启动自动清理加冷却** - 节点数超阈值时的自动测速清理改为同一订阅 12 小时内只跑一次（冷却记录在订阅缓存），新增 `--no-clean` 跳过；避免每次 `start` 都全量测速并可能二次重启
- **隐式停止不再弹 sudo** - `start`/`clean` 遇到 root 属主残留（TUN 实例等）时，不再由 `stop()` 内部 sudo 提权，改为报错引导手动清理或使用 `sub clean`（`stop` 命令本身的 sudo 提权保留）
- **可选 `controller_secret` 设置** - `settings.json` 设置后，external-controller 启用 Bearer 认证（系统锁定，订阅/覆写无法伪造），`ui` 命令会提示密钥；面向多用户环境
- **支持 `--flag=value` 形式** - `--timeout=3000`、`--mirror=url` 等与空格分隔形式等价
- **非 TTY 下测速不再逐节点刷屏** - 管道/重定向时只输出汇总行
- **`mihomo log` 的 Ctrl+C 不再打印"正在退出..."** - follow 场景这是常规退出
- **`status` 未运行时也显示模式** - 有配置文件时展示上次构建的 TUN/Mixed
- **`update` 权限失败给出 sudo 提示**
- **`test`/`clean` 与 `sub test`/`sub clean` 帮助区分** - 前者经运行中的主实例，后者用隔离实例、无需主实例运行
- **`status` TUN 模式端口显示** - 不再显示「未知」，改为「TUN 接管」并标注备用监听端口
- **`sub use`/`ow on`/`ow off` 触发重启时透传启动选项** - `-s`/`-t`/`-j`/`--no-clean` 等不再被丢弃
- **订阅「永久」到期显示** - 机场 `expire=0` 不再显示成 `1970-01-01`，改为「永久」
- **`curl` 未安装时明确提示** - 内核下载不再报「退出码 null」

### 内部

- 抽出 `src/progress.ts`（进度条与结果格式化），解开 `commands/start` ↔ `commands/subscription` 的循环依赖
- 订阅缓存损坏时与 settings.json 一致：先备份再回退默认
- 合并订阅任一来源失败即取消其余下载，不再白等
- `applyOverwrite` 恒返回浅拷贝，避免构建时的锁定键删除污染订阅原始对象（debug stage1 失真）
- `isGithubUrl` 对多 URL 合并订阅要求全部来源为 GitHub 才按 GitHub 策略
- `--mirror` 默认镜像收敛为 `DEFAULT_MIRROR` 常量（与可用镜像列表首项一致）
- `buildConfig(subRawContent, mode, scope?)` 新增可选订阅作用域参数（`{ subName, subUrl }`），由 `prepareConfigForStart` 组装传入；作用域过滤在 `buildConfig` 顶部统一执行一次，确保被排除的覆写文件不会污染 `exclude-filter` 与 debug 输出
- `match` 元数据键在 `loadOverwriteFile` 阶段即抽成结构化字段并从 config 剥离，保证它永不进入最终 mihomo 配置

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
