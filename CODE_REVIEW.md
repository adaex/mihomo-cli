# 代码审查：潜在风险与优化项

> 本轮审查：2026-09-01（v3.8.0 代码基线）
> 范围：全部 `src/`（core + commands）；重点复核上一轮「仍待处理」9 项
> 上一轮：2026-08-22（v3.6.0）

**维护约定**：本文档标注"仍待处理"的条目会随代码演进失效——上上轮清单跨越 v3.0～v3.6 六个版本未更新，复核后发现 7 项里 2 项早已修复、2 项判断有误。改动涉及本文条目时同步更新状态；下轮审查前先复核全部"仍待处理"，不要直接沿用。审查结论要给复现步骤而非静态推测。

---

## 本轮（v3.8.0）已修复

上一轮「仍待处理」9 项全部处理完毕，另修 1 项本轮新发现的高危。每条都经实际复现确认并在修复后回归验证。

### 新发现高危：`settings.json` 并发写静默丢数据

- **位置**：`settings.ts` 的 `settingsCache`（进程级缓存）+ `writeSettings`（全量合并写回）
- **机制**：无任何跨进程锁（全仓 `flock`/`O_EXCL` 此前零命中）。两个 CLI 进程各自读到旧全量、各自写回，后写者把先写者的条目整块抹掉——**而先写者已经打印了「已添加」**
- **实测**（修复前）：
  - 6 个并发 `sub add` → 期望 7 条，实际 4 条，3 条静默丢失
  - 慢速 `sub add`（跨网络下载）期间执行 `tunnel add` → `tunnel add` 报告成功，最终 `tunnels: null`。订阅与隧道同住一个文件，**互不相干的命令互相摧毁**
- **触发条件很日常**：机场慢时 `sub add` 要跑十几秒，用户在另一个终端标签做别的操作即可
- **修法**：新增 `paths.withFileLock`（`O_EXCL` 建锁文件，POSIX 下创建即原子）+ `settings.updateSettings`（持锁完成读-改-写）。所有数组类改动（`addSubscription`/`removeSubscription`/`addTunnel`/`removeTunnel`）改走后者
  - 仅「写前重读盘」不够：读与写之间仍有窗口，实测仍丢 3 条。必须把整个读-改-写圈进锁里
  - 陈旧锁（>10s，持锁进程崩溃）会被强夺，避免一次崩溃让后续所有命令永久卡死
- **回归验证**：6 并发全部保留；`tunnel add` 不再被抹；陈旧锁场景 0.045s 完成不卡死；`paths.spec.ts` 6 个单测锁定（含用真实子进程验证互斥）

### 上轮「仍待处理」逐项修复

| 上轮编号 | 问题 | 修法 |
| --- | --- | --- |
| 1 | 内核下载来源未钉死（比无 checksum 更实际的缺口） | 新增 `assertTrustedAssetUrl`：下载 host 白名单（github.com 等四个）+ 强制 https，**校验在加镜像前缀之前**（加了前缀就看不出原始 host）。curl 补 `--proto '=https' --proto-redir '=https'`（实测 `-L` 会跟随 302 降级到明文 http 并落盘）与 `--max-filesize`。下载后比对 `asset.size`（此前该值只用于显示） |
| 2 | tar 解压守卫漏 symlink 成员 → 任意文件 chmod 755 | 双守卫：`-tzf` 查路径穿越（条目名干净，含空格文件名也可靠）+ `-tvzf` 首字符查条目类型，拒绝 `l`/`h` 等非普通文件；解压加 `--no-same-owner`；`findBinaryInDir` 的 `statSync` 改 `lstatSync` 并只认普通文件。实测攻击归档已被挡下，正常归档不误拒 |
| 3 | `Subscription-Userinfo` 解析边界 | `parseUserInfo` 只收有限非负数，其余按缺失处理；无有效 kv 返回 null（此前返回 `{}` 是 truthy）。`saveSubscriptionMeta` 四字段改逐个判存在性再赋值。`UserInfo` 类型改为全可选——声明为必填会让「缺字段」在类型层面不可见 |
| 4 | sudo 中间脚本 `writeFileSync` 的 mode 不重放 | `daemon.ts` / `process.ts` 两处写完显式 `chmodSync(0o700)`。实测 0666 残留文件重写后仍是 0666，而该文件下一步就交给 sudo 执行 |
| 5 | `restartDaemon` 热重载信任 9090 上的任意响应 | `tryHotReload` 先确认 `isDaemonRunning`，再探 `/version` 确认应答方是 mihomo（返回体带 version 字段），才发 PUT |
| 6 | `daemon off` 在 plist 被手动删除后是静默 no-op | 判据从「plist 是否存在」改为「plist 不在**且**无 root 内核在跑」。数据层 `disableDaemon` 与命令层 `daemonOff` 两处同步（只改一处会被另一处的守卫短路） |
| 7 | `daemon on` 遗留 root 属主 pid 文件 | `enableDaemon` 的 sudo 脚本在 `pkill` 后补 `rm -f <pidFile>` |
| 8 | `__proto__` 作订阅名致缓存永久写不进 | `readSubscriptionCache` 返回 `Object.create(null)`，并把 `JSON.parse` 结果拷进无原型对象（直接返回会重新踩回设置原型的坑） |
| 9 | 级联删除的空洞（4 项，均无告警） | proxy 与 group 同名 → 告警（不自动删，删哪个都可能不对）；`use` 引用不存在的 provider → 移除并告警；节点池为空 + `include-all` 的空组 → 移除（此前保留但实际无出口）；`group.proxies` 是字符串 → 按单元素处理并告警（此前整体跳过、非法结构落盘）。6 个新单测锁定，含「正常配置不产生告警」的回归用例 |

另修：`needsAutoUpdate` 未来时间戳（时钟被改过/跨时区调时）会让差值恒为负 → 订阅永不自动更新、静默过期失联，现视为缓存不可信立即更新；`normalizeMirrorUrl` 从 `startsWith('http')` 改为 `URL` 解析 + https 白名单（此前放行 `httpfoo://x`、明文 `http://`，并把 `ftp://e.test` 拼成 `https://ftp://e.test/`）；`startTunnel` 在等待转发建立的窗口内注册一次性清理——此前 Ctrl+C 会留下孤儿 ssh + 一份声称健康的运行态文件（实测持久残留不自愈，`tunnel up` 报「已在运行」而 `status` 报「假活」，自相矛盾），成功后立即注销以保持「隧道活过 CLI 退出」的既定语义。

---

## 本轮复核：文档已过期的条目

- **匿名节点 collapse（上轮「仍待处理 9」的子项）已失效**：上轮称无 `name` 元素会被去重折叠、告警显示 `"undefined"`。实测现在 `assertConfigShape` 会抛 `CliError: proxies[0] 缺少有效的 name` 并带 hint，该路径走不到。条目已删

---

## 本轮验证为健壮、无需改动

避免下轮重复排查：

- **YAML 安全**：无原型污染（`__proto__` 只作自有属性）；别名炸弹不放大——解析共享引用，`dumpYaml` 保留锚点，9^7 叶子的归档输出仅 826 字节
- **隧道三条红线**：`-D` 恒绑 `127.0.0.1`、host 校验（`-oProxyCommand=id`/`h;id`/`h$(id)`/换行注入全部拒绝）、状态真实探测端口——均正确实现
- **`started_by` 单向提升**：只有 auto→manual 一条路径
- **PID 复用**：`isRunning` 与 `cleanupAll` 都走命令行匹配，不裸信 PID 文件
- **两张 flag 表无漂移**：12 个带值选项全在 `VALUE_FLAGS`，`cmdStart` 的 3 个布尔选项全在 `BOOL_FLAGS`
- **非 TTY 退出码**：`reset` 与 `sub remove` 模糊匹配都正确抛 `CliError` 退 1
- **HTTP 超时覆盖响应体读取**（abort 中断流）；覆写加载顺序确定（显式 sort，`LC_ALL=C` 下一致）

---

## 上一轮（v3.6.0）已修复

按严重度排列。每条都经实际复现确认，非静态推测。

### 高危

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| 1 | 错误响应体绕过 50MB 上限 | `http.ts` `!response.ok` 分支 | `await response.json()` 不过大小检查。实测 60MB 错误体使客户端 RSS 增长 303MB；攻击者只需返回非 2xx 即可绕过全部防护。已改为限量 64KB 读取（错误体仅用于诊断），修后 RSS 增长 9MB |
| 2 | 垃圾响应覆盖可用订阅 | `subscription.ts` 下载后写盘处 | 只要能解析成对象就 `saveSubscriptionRawConfig` 原子覆盖。机场返回 `{"error":"quota exceeded"}` 时报「已更新 (0 节点)」，磁盘上可用订阅被**不可恢复**覆盖，随后 mihomo 带零节点启动 → 断网。在 `start` 自动更新路径上，用户无操作即触发。已加 `assertLooksLikeSubscription`，写盘前要求 `proxies`/`proxy-groups`/`proxy-providers` 至少其一非空 |
| 3 | `ps` 截断致测速实例泄漏 | `process.ts` `isProcessCommandMatching` | BSD/macOS 的 `ps` 即使 stdout 非 tty 也把 command 列截断到 79 列。测速实例的 needle（`test/runtime/config.yaml`）起始偏移随用户名增长——`alice` 为 80、`jonathan.smith` 为 98，常见家目录下均越界 → 匹配恒 false → `stopTestInstance` 跳过 SIGKILL 却仍删 pid 文件，内核残留占着 27890/29090 且再无记录，下次 `sub test` 直接启动失败。已加 `-ww` |
| 4 | `sub add` 失败劫持活跃订阅 | `commands/subscription.ts` | `setDefaultSubscription` 在下载前执行，回滚的 `removeSubscription` 把 active 落到 `subs[0]` 而非用户原选择。复现：active=`work`、subs=`[airport-a, work]`，添加不可达 URL 失败后 active 变成 `airport-a`，下次 `start` 静默连错机场。已把切换移到下载成功之后 |
| 5 | `MIHOMO_CLI_DAEMON_LABEL` 未校验 → root 任意路径写 | `constants.ts` + `daemon.ts` | 该值经 `path.join` 拼成 plist 路径后，是 `sudo install -m 644 -o root` 的写入目标与 `sudo rm -f` 的删除目标。`path.join` 折叠 `..`：实测 `'../../etc/sudoers.d/evil'` → `/etc/sudoers.d/evil.plist`，内容还部分可控 → 提权原语。已加字符集校验（双层：constants 回退默认 + daemon 写操作入口抛 `CliError`） |

### 中危

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| 6 | `exclude-filter` 无锚点误排除节点 | `config.ts` | mihomo 的 `exclude-filter` 是无锚点正则搜索（Go `regexp.MatchString`）。覆写注入名为 `HK` 的节点后，订阅里的 `HK-01`/`HK-02` 全被踢出 `include-all` 分组。已改 `^(?:...)$` 整名锚定（与订阅自带 filter 拼接安全：`\|` 优先级最低，锚定分支独立） |
| 7 | 配置 YAML 笔误抛裸 `TypeError` + 堆栈 | `config.ts` `validateConfig` | 三处 `as` 断言无校验。复现四种崩溃：`proxies` 含 null 元素（列表留空行）、`rules` 写成标量（漏 `-`）、`proxy-groups` 写成映射、`rules` 含非字符串。用户配置错误被当成程序 bug 打印堆栈。已加 `assertConfigShape` 转 `CliError`；同一 null 崩溃在 `test-instance.ts` `isProxyValid` 也修了 |
| 8 | `~key`/`+key` 作用于非数组静默损坏 | `overwrite.ts` | 静默包成单元素数组：`~dns: {enable:true}` 把映射 `dns` 变成 `[{enable:true}]` 并丢掉原有 `listen`，而 mihomo 要求 `dns` 是映射 → 非法配置。`~mode: global` → `["global"]`，`log-level+: debug` → `["debug"]` 同理。已改为抛 `CliError`；目标不存在时仍放行（新增数组的正常用法） |
| 9 | `maskUrl` 逗号切分致 token 明文泄漏 | `settings.ts` | 无条件按逗号切分，`?nodes=us,hk&token=SUPERSECRET1` 被劈开后两段都识别不出 token 参数 → **密钥明文输出**。同一根因让含逗号的合法单 URL（`?flag=clash,meta`）被误判多源，第二段不合法致 `sub add` 报「无效的 URL」无法添加。已统一判据为「切分后每段都是合法 http(s) URL 且不止一段」，三处同步（`maskUrl`/`isMultiUrl`+`splitUrls`/`splitUrlsLocal`） |
| 10 | `settings.json` 合法 JSON 非对象绕过损坏恢复 | `settings.ts` `readSettings` | `try` 只捕获 parse 抛错，`null`/`[]`/`123`/`"hi"` 都直接赋给缓存：不备份、不告警。`null` 让 `getSubscriptions()` 抛裸 `TypeError` + 堆栈，且 `settingsCache !== null` 恒 false 使缓存彻底失效；字符串被 `writeSettings` 展开成 `{"0":"h","1":"i",...}`。已加类型校验并复用备份分支 |
| 11 | `subscriptions` 非数组被字符串展开 | `settings.ts` | `[...(settings.subscriptions \|\| [])]` 对字符串是合法展开，手改成 `"oops"` 后 `addSubscription` 写出 `["o","o","p","s",{...}]` 且不报错。已在 `getSubscriptions`（唯一读取入口）收口校验，三处直读改为经它 |
| 12 | `reset` 忽略 `cleanupAll` 结果 | `commands/reset.ts` | root 实例（TUN）下走 `sudo pkill`，用户取消密码时 `failed` 被静默丢弃，继续 `rmrf` 数据 → 孤儿 root 进程跑在已删配置上且用户不知情。已改为删数据前复查 `getMihomoPids` 并抛 `CliError` 中止 |
| 13 | `reset --full` 残留含密钥的 `.bak` | `commands/reset.ts` | `settings` target 只删主文件，`settings.json.bak`（`readSettings` 损坏时备份）带 `controller_secret` 与订阅 token 明文残留，与「已重置: 设置」矛盾。已纳入删除路径（`cache.json.bak` 在 `subscriptions/` 内随整目录删除，无需单列） |
| 14 | `reset` 结果依赖参数顺序 | `commands/reset.ts` | `subs` 的 `onAfter` 会 `writeSettings` 重建 `settings.json`，故 `reset settings subs` 留下 `{}`，而 `reset subs settings` 才真删。已按注册表顺序执行 |
| 15 | `match` 订阅名大小写与 `sub use` 不一致 | `overwrite.ts` | `findSubscriptionFuzzy`（`sub use`/`test` 等的解析口径）大小写不敏感，但 `match: {subscription: home}` 精确比对匹配不上订阅 `Home`——同一名称两套规则。已统一为不敏感 |

### 低危

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| 16 | `parseIntArg` 接受危险值 | `utils.ts` | 无范围校验：`-j 0` 让测速起 0 个 worker、结果数组全空洞、被报成「所有节点失败」（伪造结果；全死守卫拦住不删节点故无数据丢失）；`-t 5s` 静默取 5ms 让全部节点超时；`-t -1` 取 -1。全部 13 个调用点语义都是正整数，已改为非纯十进制整数或 `<1` 一律抛 `CliError`。连带把 `cmdTest`/`cmdClean` 的参数解析移到 `requireRunning` 之前（此前 `test -j 0` 只报「mihomo 未运行」） |
| 17 | 合并订阅错误指向被连带取消的 URL | `subscription.ts` | 任一 URL 失败即 `internal.abort()`，按顺序取第一个 error 报出的往往是被取消的那条（`This operation was aborted`），真正的 403/token 过期被隐藏，用户去排查错误的订阅源。已改为优先报非 abort 错误 |
| 18 | `cmdDirectory` 丢弃 Promise 致 `CliError` 绕过收口 | `commands/directory.ts` | `void dispatchSubcommand(...)` 使 `dir open <未知target>` 抛的 `CliError` 变成「未处理的 Promise 拒绝」，丢掉 label 颜色与 hint 列表。已改 async + await |
| 19 | `ow`/`dir` 未知子命令静默回落 | `commands/overwrite.ts`、`directory.ts` | 只给 `fallback` 不给 `onUnknown`，`ow onn` 静默打印列表且 exit=0（对比 `sub adz` 会报错 + did-you-mean + exit=1）。已补 `onUnknown`；注意需同时显式注册 `list` 子命令，否则 `ow list` 会被判为未知 |
| 20 | 测速实例 pid 记录时机的 SIGINT 泄漏窗口 | `test-instance.ts` | spawn 与写 pid 文件之间被 Ctrl+C 中断时，只认 pid 文件的清理逻辑漏掉 detached 子进程。已加模块级 `spawnedTestPid` 作第二来源 |
| 21 | `reset` 保活取消路径 exit=0 | `commands/reset.ts` | `console.error` + `return` 使「重置中止」退出码为 0，且绕过统一渲染。违反项目错误约定（只豁免信号处理器与 `viewLogWithTail`）。已改 `CliError` |
| 22 | `mihomo on`/`off` 丢弃启动选项 | `commands/registry.ts` | 唯二不透传 `...args.slice(1)` 的 rewrite，`mihomo on -s` 静默吞掉 `-s`，而 README 声明二者等价。已补透传 |
| 23 | `subs` 别名缺失 | `commands/registry.ts` | `directory` 有 `dirs` 但 `subscription` 无 `subs`，命名规范的「简写复数」档未落地。已补 |
| 24 | `restartDaemon` 抛裸 `Error` | `daemon.ts` | 唯一遗留的数据层预期错误裸抛点。已改 `CliError` |

---

## 平台假设

> 本节记录于 v3.6.0 那轮；其中的「本轮已加」指 v3.6.0。平台守卫现已长期存在。

**全仓曾无平台守卫**（v3.6.0 补上）。此前 `process.platform !== 'darwin'` 零命中、`package.json` 无 `os` 字段。

macOS 硬依赖清单：

- **launchd 保活整套**，无 systemd/Windows 后端：`/Library/LaunchDaemons`、plist XML（`RunAtLoad`/`KeepAlive`）、`launchctl bootout/bootstrap/kickstart`、`install -o root -g wheel`（`wheel` 组 Debian 不存在）
- **`spawn('open', ...)`**：`process.ts` 单点收口，4 个调用方。恶化点是 `child.on('error', () => {})` 吞掉 ENOENT 后 `openUrl` **恒返回 true**，所有调用方的 `if (!success) 请手动打开…` 成死代码；Debian 的 `/usr/bin/open` 指向 `run-mailcap`，会把 URL 当 MIME 附件处理——属主动做错
- **BSD 专有命令语法**：`stat -f%z`（GNU 需 `-c%s`，且 `|| echo 0` 把失败吞成 0 → 保活日志轮转在 Linux 永不触发）、`tail -25`、`ps -o command=`
- `sudo` 5 处、`pgrep`/`pkill` 5 处、`#!/bin/bash` 生成脚本 4 处

**已可移植（值得肯定）**：`kernel.ts` 的资产选择用真实 `process.platform` + arch 映射，无硬编码 darwin；全部用户数据路径经 `os.homedir()` + `path.join`；**零网络重配**（`networksetup`/`scutil`/`route`/`pfctl` 全零命中），TUN 路由完全委托内核。

v3.6.0 已加：`package.json` 的 `"os": ["darwin"]` + `index.ts` `main()` 开头的平台守卫（豁免 `help`/`version`，留 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 开发逃生阀，守卫先于 `ensureDirs` 以免在不支持的平台污染家目录）。此前 Linux 上的实际表现是「部分成功」：`status`/`sub` 看着正常 → `daemon on` 输完 root 密码才撞 `/Library/LaunchDaemons` → `ui` 报成功却什么都没打开。快速失败严格优于这种静默误行为。

---

## 上一轮清单复核（2026-05-07 → v3.6.0）

上一轮标「仍待处理」的 7 项，逐项核实结论：

| 上轮编号 | 结论 | 依据 |
| --- | --- | --- |
| #4 TUN TOCTOU | **仍存在**，见本轮「仍待处理 4」 | 中间脚本仍在；建议的注释未加；另发现 mode 不重放与目录 mode 不强制 |
| #9 settingsCache | **部分修复** | 方案 A 已落地（写成功后才更新缓存）；方案 B（返回克隆）未做，但当前全部调用方只读，无实际触发点 |
| #10 maskUrl 逗号 | **上轮判断不完整，本轮已修** | 上轮只提「切碎」，实际后果是 **token 明文泄漏**（query 含逗号时）。本轮修复见「已修复 9」 |
| #12 child.pid | **已修复** | `process.ts` 与 `test-instance.ts` 均校验；TUN 走脚本写 PID 后 JS 侧亦校验 |
| #14 displayWidth emoji | **已消失** | 函数随其唯一消费者 `commands/bench.ts` 在 v2.9.2 删除，问题不再适用 |
| #15 ensureDirs 冗余 | **仍存在**，纯性能项 | 见「仍待处理 9」 |
| #17 内核 SHA256 | **建议不可行，已重新定位** | 上游确无 checksums（127 资产实测）。真实缺口是下载 host 未钉死，见「仍待处理 1」 |

上轮「新发现」两项：

- **`mihomo clean` 与 `sub clean` 同名不同义**：结构仍在，但已文档化缓解——registry 的 usage 分别括注「经主实例」/「独立实例，不动主实例」，且 `test.ts` 在 TUN 场景主动引导改用 `sub clean`
- **autoUpdate 10s 超时后底层 fetch 仍可能写盘**：**实质已修复**。取消由调用方显式做（建 `AbortController`、超时后 `abort()` 并 drain），signal 全链路贯通至 `fetch`，把底层 60s 压到 10s。残留窄窗：`signal.aborted` 无前置检查，同一 tick 完成的 fetch 续体仍会写一次盘——但该结果会被收录并如实打印「已更新」，语义自洽

上轮标「已修复」的项本轮抽查确认真修好：#2 原子写、#7 updateInterval 正整数校验、#13 formatBytes Infinity、#18 findBinaryInDir 深度限制、#20 settings 损坏备份（**仅限 parse 抛错场景**——合法 JSON 非对象的漏洞见「已修复 10」）。

---

## 测试与工程

- 单测 165（v3.6.0 时 101）。v3.8.0 本轮新增：`withFileLock` 的 6 项（含用真实子进程验证跨进程互斥、陈旧锁强夺、异常路径释放）、`parseUserInfo` 边界 8 项、级联删除空洞 6 项（含「正常配置不产生告警」的回归用例）
- 覆盖面仍窄：`process.ts`/`subscription.ts` 这两个最大模块（各约 700 行、且是跑 `sudo` 与杀进程的地方）几乎零单测。这是 CLAUDE.md 明确的取舍（「仅覆盖高危纯函数」），但值得记录
- **注意 `biome check .` 在 worktree 里会检查 0 个文件**：`biome.json` 的 `files.includes` 排除了 `**/.claude`，而 worktree 建在 `.claude/worktrees/` 下。在 worktree 中改动后要显式跑 `npx biome check src/`，否则格式问题会漏到提交（本轮踩过）
- v3.6.0 加的 GitHub Actions CI（`macos-latest`，因 `os: ["darwin"]` 后 ubuntu 上 `npm ci` 会平台不匹配失败）跑 typecheck/lint/test/build
- v3.6.0 加的 `prepublishOnly: npm run build`：`dist/` 被 gitignore 且此前无发布钩子，漏跑 build 即发布陈旧或缺失产物
