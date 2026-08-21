# 代码审查：潜在风险与优化项

> 本轮审查：2026-08-22（v3.6.0 代码基线）
> 范围：全部 `src/`（core + commands）+ 文档一致性 + 平台假设
> 上一轮：2026-05-07（v2.9.x），其"仍待处理"清单已在本轮逐项复核，结论见文末

---

## 本轮已修复

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

## 仍待处理

按建议优先级排列。均为已确认存在、但需权衡或成本较高的项。

### 1. 内核下载缺完整性校验（供应链）

- **位置**：`kernel.ts` 下载 → 解压 → `chmod 755` 全链路
- **现状**：无 SHA256/签名。产物在 TUN/daemon 下**以 root 运行**
- **上一轮建议不可行**：已核实上游 v1.19.30 release 共 127 个资产，**零 checksum 文件**（全为 `.gz`/`.deb`/`.rpm`）。`kernel.ts` 注释「上游 release 不提供 checksums」是准确的，上一轮报告的假设有误
- **现有防护**（不弱）：`tar -tzf` 预检路径穿越、`gzip -dc` 走 buffer 不用 shell 重定向、下载后跑 `-v` 自检并在失败时删文件
- **可行加固**（按性价比排序）：
  1. 把 `browser_download_url` 的 host 钉死为 `github.com`（只允许镜像做 URL 前缀），并强制 https。`--mirror-all` 下 API 也走镜像，故镜像可返回指向任意主机的下载地址，而 `withMirror` 对非 github URL 原样放行——这是比"无 checksum"更实际的缺口
  2. 比对 `asset.size`：该值已从 API 取到但仅用于显示
  3. `normalizeMirrorUrl` 加 scheme 白名单（当前接受 `http://` 明文与 `httpfoo://`）
  4. 自检强度有限：一行 `#!/bin/sh; echo "Mihomo Meta v1.19.16"` 的脚本即可通过 `-v` 正则

### 2. tar 解压守卫漏 symlink 成员 → 任意文件 chmod 755

- **位置**：`kernel.ts` 路径穿越守卫 + `findBinaryInDir` + `chmodSync`
- **机制**：守卫只拒绝绝对路径和含 `..` 的**条目名**。名为 `mihomo`、linkname 指向任意路径的 symlink 成员条目名合法，直接通过；`findBinaryInDir` 用 `statSync`（跟随符号链接）把它当二进制返回，`chmodSync(targetPath, 0o755)` 沿链接作用到目标
- **实测**：`chmod 600` 的受害文件被改成 755。（GNU tar 拒绝「symlink + 经其写文件」的两段式写入，故写内容不成立；chmod 原语成立）
- **修法**：用 `tar -tvzf` 检查条目类型或加 `-h`/`--no-same-owner` 拒绝非普通文件，遍历改 `lstatSync`

### 3. `Subscription-Userinfo` 解析边界

- **位置**：`subscription.ts` `parseUserInfo` + `settings.ts` `saveSubscriptionMeta`
- **三个已确认的边界**：
  - `total=Infinity` → `JSON.stringify` 写成 `"total":null`
  - `expire=abc` → 塞 0，而 `formatTimestamp(0)` 特判返回「永久」——垃圾值被展示成「永久有效」，正好是最误导的方向
  - 负数不过滤：`upload=-5` 原样入库，百分比失真
- **更严重的关联项**：`parseUserInfo` 对无 `=` 的头（如 `garbage`）返回 `{}`（truthy），于是四个字段全 `undefined`，`{...old, ...new}` 后 `JSON.stringify` 丢键 → **已有 upload/download/total/expire 全部被抹掉**；缺字段场景同理会静默清除旧值（旧缓存有 `expire`、新响应头无 → 到期日凭空消失）
- **修法**：只接受有限非负数，其余按缺失处理（不落盘）；`parts` 无有效 kv 时返回 null；只赋 `!== undefined` 的字段

### 4. TUN 中间脚本 TOCTOU + `writeFileSync` 的 mode 不重放

- **位置**：`process.ts` `launch-tun.sh` 生成/执行、`daemon.ts` `daemon-*.sh`
- **两个事实**：`writeFileSync(..., {mode})` 的 mode **仅在创建新文件时生效**——前次崩溃残留同名文件时复用其权限位（实测重写 0666 文件后仍是 0666）；`ensureDirs` 在目录已存在时跳过 `mkdirSync`，故 `runtime/` 的 0700 对既存目录不生效（实测 0777 目录保持 0777）
- **两个 sudo 执行点都不验证「执行的就是刚写的那个文件」**（无 `O_EXCL`、非 fd-based exec）
- **前提**：需要 `runtime/` 写权限（正常 0700），故属防御纵深而非直接可利用
- **修法**：写后显式 `chmodSync`，或用随机临时名 + `O_EXCL`

### 5. `restartDaemon` 热重载信任 9090 上的任意响应

- **位置**：`daemon.ts` `tryHotReload` / `restartDaemon`
- **机制**：只确认 plist **文件存在**，随后 `PUT /configs` 到固定地址，`status === 204 || res.ok` 即返回成功并跳过 kickstart。无任何校验确认应答方是 launchd 托管的 root 内核
- **后果**：9090 被其他服务占用（另一个 Clash、开发服务器）且对该 PUT 返回 2xx 时，CLI 打印「已重启 (保活)」而 daemon 内核仍跑旧配置——配置变更静默未生效

### 6. `daemon off` 在 plist 被手动删除后是静默 no-op

- **位置**：`daemon.ts` `disableDaemon` 的 `isDaemonEnabled()` 守卫（仅 `existsSync`）
- **场景**：用户 `sudo rm` plist（自然的手动清理尝试）但任务仍处 bootstrapped，`disableDaemon` 直接返回，永不执行 `launchctl bootout`。`cmdStop` 随后也走非 daemon 路径，`cleanupAll` 杀掉 root 进程后 `KeepAlive` 立即拉起 → 永远停在「仍有进程残留」，且 CLI 无任何路径可 `bootout`

### 7. `daemon on` 遗留 root 属主 pid 文件，阻塞后续 `start`

- **位置**：`daemon.ts` `enableDaemon` 的脚本 `pkill` 后未 `rm -f <pidFile>`
- **序列**：`start tun`（root pid 文件）→ `daemon on`（TUN 进程被杀，root pid 文件留下）→ `daemon off`（只 chown `logFile`/`dataDir`，不含 pid 文件）→ `start` 撞上 `hasRootResidue()` 拒绝启动，需手动 `sudo rm`。用户有提示引导，但这个死胡同完全由 CLI 自身的 on/off 循环造成

### 8. `__proto__` 作订阅名致缓存永久写不进

- **位置**：`settings.ts` `SAFE_NAME_RE`（`\w` 含下划线）+ `readSubscriptionCache`
- **机制**：`__proto__`/`constructor`/`prototype` 均通过名称校验（**路径穿越本身已挡住**，上一轮的穿越修复有效）。但 `cache[subName] = {...}` 对 `__proto__` 是设置原型而非自有属性 → `cache.json` 落盘为 `{}` → `updated_at` 永远缺失 → `needsAutoUpdate` 恒 true，**每次 start 都重新下载该订阅**（跨进程无原型污染，JSON 序列化即丢失）
- **修法**：`readSubscriptionCache` 用 `Object.create(null)` 或 `Map`；名称校验拒绝这三个保留名

### 9. 其他确认存在的小项

- **级联删除仍有空洞**（`config.ts`，均无告警）：proxy 与 proxy-group **同名**时两者都留下（`validNames` 是合并 Set，冲突不可见）→ mihomo 报重复名错误；`use: ['ghost-provider']` 引用不存在的 provider 从不校验，且 `use` 计入 `hasOtherSource` 使该组免于删除；所有 proxy 删完 + 组带 `include-all: true` → 空组保留且 `MATCH,AUTO` 留存；组的 `proxies` 是**字符串**而非列表时被 `Array.isArray` 守卫整体跳过
- **`~proxies` 元素缺 `name` collapse**（`overwrite.ts` + `config.ts`）：无 name 元素的 `name === undefined`，`deduplicateByName` 比较时全部相撞，两个匿名注入节点只活一个，告警显示 `移除了 1 个重名节点: "undefined"`
- **TUN 丢弃用户 `tun` 子键**（`config.ts`）：`systemConfig.tun = TUN_CONFIG.tun` 整体覆盖，覆写里的 `device`/`mtu` 全丢。与 `dns` 的逐键合并风格不一致，且 `tun` 子键未列入 CLAUDE.md 的锁定键清单
- **`key!` 与 `~`/`+` 组合语义矛盾无提示**（`overwrite.ts`）：`~proxies!` 走 merge（`forceOverwrite` 成死代码），`+proxies!` 走 prepend；两者都绕过 `collectOverwriteProxyNames` 的字面量匹配 → `exclude-filter` 不生效 → 注入节点在 `include-all` 组里被计两次
- **`ensureDirs` 无 memo**（`paths.ts`）：15 个调用点，纯性能项（`existsSync` 短路后约 5 次 stat）
- **`.bak` 备份不指定 mode**（`settings.ts`）：`copyFileSync` 继承源权限，无下限保证
- **重复输出**（`process.ts` + `commands/stop.ts`）：数据层 `console.log` 残留 PID 建议后返回，`handleStopResult` 又抛携带同样 PID 与 hint 的 `CliError`
- **`url-domain: '.example.com'`（前导点）匹配不到任何东西**：fail-closed，覆写被静默跳过而非报错

---

## 平台假设

**全仓无平台守卫**（本轮已加，见下）。此前 `process.platform !== 'darwin'` 零命中、`package.json` 无 `os` 字段。

macOS 硬依赖清单：

- **launchd 保活整套**，无 systemd/Windows 后端：`/Library/LaunchDaemons`、plist XML（`RunAtLoad`/`KeepAlive`）、`launchctl bootout/bootstrap/kickstart`、`install -o root -g wheel`（`wheel` 组 Debian 不存在）
- **`spawn('open', ...)`**：`process.ts` 单点收口，4 个调用方。恶化点是 `child.on('error', () => {})` 吞掉 ENOENT 后 `openUrl` **恒返回 true**，所有调用方的 `if (!success) 请手动打开…` 成死代码；Debian 的 `/usr/bin/open` 指向 `run-mailcap`，会把 URL 当 MIME 附件处理——属主动做错
- **BSD 专有命令语法**：`stat -f%z`（GNU 需 `-c%s`，且 `|| echo 0` 把失败吞成 0 → 保活日志轮转在 Linux 永不触发）、`tail -25`、`ps -o command=`
- `sudo` 5 处、`pgrep`/`pkill` 5 处、`#!/bin/bash` 生成脚本 4 处

**已可移植（值得肯定）**：`kernel.ts` 的资产选择用真实 `process.platform` + arch 映射，无硬编码 darwin；全部用户数据路径经 `os.homedir()` + `path.join`；**零网络重配**（`networksetup`/`scutil`/`route`/`pfctl` 全零命中），TUN 路由完全委托内核。

本轮已加：`package.json` 的 `"os": ["darwin"]` + `index.ts` `main()` 开头的平台守卫（豁免 `help`/`version`，留 `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` 开发逃生阀，守卫先于 `ensureDirs` 以免在不支持的平台污染家目录）。此前 Linux 上的实际表现是「部分成功」：`status`/`sub` 看着正常 → `daemon on` 输完 root 密码才撞 `/Library/LaunchDaemons` → `ui` 报成功却什么都没打开。快速失败严格优于这种静默误行为。

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

- 单测从 55 增至 101（`npm test`，`node:test` 经 tsx，零新增依赖）。本轮新增覆盖：配置形态校验、`exclude-filter` 锚定、覆写数组语义误用、`match` 大小写、`parseIntArg` 边界、逗号判据
- 覆盖面仍窄：`process.ts`/`subscription.ts` 这两个最大模块（各约 700 行、且是跑 `sudo` 与杀进程的地方）零单测。这是 CLAUDE.md 明确的取舍（「仅覆盖高危纯函数」），但值得记录
- 本轮加了 GitHub Actions CI（`macos-latest`，因 `os: ["darwin"]` 后 ubuntu 上 `npm ci` 会平台不匹配失败），跑 typecheck/lint/test/build
- 本轮加了 `prepublishOnly: npm run build`：`dist/` 被 gitignore 且此前无发布钩子，漏跑 build 即发布陈旧或缺失产物
