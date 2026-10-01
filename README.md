# mihomo-cli

一个基于命令行的 mihomo (Clash.Meta) 客户端，**仅支持 macOS**。

服务托管依赖 launchd、目录/UI 打开依赖 `open`、提权依赖 `sudo`，均无其他平台实现，故在非 macOS 上会直接报错退出而非部分可用。Windows / Linux 适配尚无时间表。

## 功能特性

- 🌐 **订阅管理** - 添加/更新订阅，支持流量统计和到期时间显示
- 🔄 **自动更新** - 启动时自动检查并更新过期订阅
- 🔍 **模糊匹配** - `sub use` / `update` / `remove` 均支持订阅名称模糊匹配（大小写不敏感）
- 📝 **覆写配置** - 在订阅基础上进行自定义覆写：YAML 声明式覆盖/前插/追加，JS 脚本自由编程化处理，按订阅名/域名限定作用域，单文件启停
- 🔄 **智能重启** - `sub use` 切换订阅、`ow on/off` 切换覆写后自动重启
- 🚀 **进程管理** - 启动/停止/切换模式，自动清理残留进程
- 🛡️ **服务托管** - 基于 launchd，崩溃/登录自动拉起，代理后台常驻；日常 `start`/`stop` **全程免密**
- 🔄 **双模式支持** - Mixed 模式和 TUN 透明代理模式
- 📊 **状态监控** - 查看运行状态、内存占用、订阅流量、到期时间与更新新鲜度（紧急度着色，`--json` 机器可读）
- 🩺 **体检诊断** - `mihomo-cli doctor` 一键检查内核/服务/端口/订阅/配置/连通性/内核与 CLI 版本并给修复指引
- 🔌 **端口逃生口** - 默认 7890/9090 可经 `settings.json` 的 `ports` 覆盖，status 与 `mihomo-cli ui` 会显示实际端口
- 🔌 **连通性探测** - 启动与状态展示独立确认「代理真的通」，不通时归因到订阅过期/流量用尽/节点失效
- 🔎 **查看生效配置** - `mihomo-cli config [--json] [--reveal]` 展示由订阅与覆写推导出的运行配置，停止状态下同样可用；节点密码、UUID、provider 订阅 token 等凭据默认脱敏
- 📝 **日志管理** - 每次启动归档上一次日志，保留 7 天，支持列表/跟随/编号查看
- 🎨 **Web UI** - 一键打开 Web 控制面板 (zash/metacubexd/yacd)
- 🔄 **内核更新** - 自动检查更新，支持 GitHub 镜像加速
- 💡 **容错提示** - 命令/子命令拼错时给出 did-you-mean 纠错建议
- ⌨️ **命令别名** - `mihomo-cli` / `mh` 均可调用

## 安装

**前置要求：Node.js >= 22.22.1**（入口有版本守卫，低版本会直接报错并给出升级指引）

### 方式一：npm 全局安装

```bash
npm install -g mihomo-cli
```

### 方式二：源码安装

```bash
git clone git@github.com:adaex/mihomo-cli.git
cd mihomo-cli
npm install
npm run build
npm link
```

## 快速开始

> 全新环境直接运行 `mihomo-cli`（不带参数）会显示状态与「开始使用」引导：缺哪步列哪步。

### 1. 下载内核

```bash
# 自动选择通道：本机代理在跑时优先（低速快速失败改 gh 重试，仍经同一个本机代理）> gh > 直连
mihomo-cli kernel

# 国内网络强制走镜像（裸 --mirror 固定走裸域 gh-proxy.org）
mihomo-cli kernel --mirror

# 或用短别名指定镜像（纯 IPv6 网络用 v6）
mihomo-cli kernel --mirror cdn
mihomo-cli kernel --mirror v6

# mihomo-cli 没在跑、但本机有别的代理工具时，经指定代理出网（纯端口视为 127.0.0.1）
mihomo-cli kernel --proxy 7897
mihomo-cli kernel --proxy socks5://127.0.0.1:7897
```

### 2. 添加订阅

```bash
mihomo-cli sub add "https://your-subscription-url" "my-proxy"

# 或先在机场页面复制订阅链接，再运行（交互下自动读取剪贴板，确认后添加）
mihomo-cli sub add
```

### 3. 安装服务

```bash
mihomo-cli install
```

Mixed 模式由 launchd 服务托管（崩溃/登录自动拉起），只需装这一次。全程免密，详见「服务托管」。

### 4. 启动代理

```bash
# Mixed 模式（默认），同时开启登录自启
mihomo-cli start

# 再次执行 start = 重启并应用新配置
mihomo-cli start

# 停止并关闭登录自启
mihomo-cli stop

# 临时 TUN 透明代理（不走服务，需管理员权限）
mihomo-cli tun
```

### 5. 打开 Web UI

```bash
mihomo-cli ui          # 默认 zash
mihomo-cli ui dash     # metacubexd
mihomo-cli ui yacd     # YACD
```

## 命令参考

### 核心命令

| 命令                        | 说明                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `mihomo-cli install`            | 安装服务（Mixed 模式的前置，只需一次；升级用户会顺带清理旧的 root 服务）      |
| `mihomo-cli start [tun\|mixed]` | 启动代理并开启登录自启（`-s` 跳过订阅更新，`-u` 更新超时） |
| `mihomo-cli stop`               | 停止代理并关闭登录自启                                                       |
| `mihomo-cli uninstall`          | 卸载服务                                                                     |
| `mihomo-cli status`             | 查看运行状态（含订阅流量、到期、更新新鲜度；`--json` 机器可读，`--no-probe` 跳过连通性探测）             |
| `mihomo-cli logs`               | 列出所有日志（当前 + 历史归档）                                              |
| `mihomo-cli logs <编号>`        | 查看指定日志（`0`=当前，`1+`=归档，`-f` 实时跟随，`-n N` 行数，`-o` 打开）  |
| `mihomo-cli logs -f`            | 跟随当前日志（省略编号时默认当前，等价 `logs 0 -f`）                        |

### 订阅管理

| 命令                          | 说明                                   |
| ----------------------------- | -------------------------------------- |
| `mihomo-cli sub`                  | 列出所有订阅（含流量、到期时间）       |
| `mihomo-cli sub use <name>`       | 切换当前订阅（支持模糊匹配，自动重启；重启透传 `-s`/`-u` 等启动选项） |
| `mihomo-cli sub add [url] [name]` | 添加订阅并自动切换（名称不可重复、不能以 `-` 开头；交互下不带 URL 时自动读剪贴板并确认） |
| `mihomo-cli sub update`           | 更新所有订阅                           |
| `mihomo-cli sub update <name>`    | 更新指定订阅（支持模糊匹配）           |
| `mihomo-cli sub remove <name>`    | 删除订阅（别名 `rm`/`delete`；精确名直接删，模糊匹配需确认，`-y` 跳过） |

> 节点测速请用 `mihomo-cli ui` 打开的 Web 面板（zash/metacubexd/yacd 均内置逐节点实时测延迟），
> 或直接在订阅里配置 `url-test` 分组由内核自动选路——两者都比一次性的命令行快照更实时。

### 覆写配置

| 命令                           | 说明                       |
| ------------------------------ | -------------------------- |
| `mihomo-cli ow`                  | 查看覆写配置状态和文件列表（别名 `enable`/`disable` 亦可用于开关） |
| `mihomo-cli ow on`                   | 启用覆写配置（**默认已启用**，自动重启）                          |
| `mihomo-cli ow off`                  | 禁用覆写配置（自动重启）                                          |
| `mihomo-cli config [--json] [--reveal]` | 查看当前生效的运行配置（由订阅与覆写推导，停止状态下同样可用；凭据默认脱敏，`--reveal` 显示原文） |

> `ow on`/`ow off` 是**全局总开关**（一次开关所有覆写）。只想停用某一个文件，在该文件里写 `enabled: false`，见[单个文件的开关](#单个文件的开关enabled)

### 其他命令

| 命令                              | 说明                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `mihomo-cli kernel [--mirror [镜像]]` | 更新内核（自动选择通道：本机代理优先、回退 gh 仍经同一本机代理；`--mirror` 强制镜像，`--mirror direct` 强制直连） |
| `mihomo-cli update`                   | 更新 mihomo-cli（先查 npm 最新版，已是最新则跳过重装）              |
| `mihomo-cli ui [zash\|dash\|yacd] [-c]` | 打开 Web UI（`-c` 把控制器访问密钥复制到剪贴板；默认只提示、不动剪贴板） |
| `mihomo-cli dir`                      | 显示数据目录位置                                                    |
| `mihomo-cli dir open [target]`        | 打开指定目录（`root`, `subs`, `logs`, `data`, `runtime`, `kernel`）  |
| `mihomo-cli reset [目标...] [--full] [-y]` | 重置用户数据（可用目标：`subs`, `logs`, `data`, `runtime`, `settings`, `kernel`, `overwrites`, `service`；`--full` 删全部，`-y` 跳过确认） |
| `mihomo-cli doctor`                   | 体检诊断（内核/服务/端口/订阅/配置/连通性/CLI 版本，有异常退出码 1） |
| `mihomo-cli version`                  | 显示版本信息                                                        |
| `mihomo-cli help [命令]`             | 显示帮助（无参数显示全部；也可用 `mihomo-cli <命令> -h`）               |

### 命令别名

以下任意命令等效：

- `mihomo-cli`（推荐，也是包名）
- `mh`（简写）

> 旧版曾提供 `mihomo` / `mhm` 别名，已移除：`mihomo` 与 mihomo 内核二进制同名，
> 两个包管理器的全局 bin 会互相覆盖；从旧版升级后旧的 `mihomo` / `mhm` 链接由 npm 自动清理。

子命令组亦有别名：`subscription` = `sub`/`subs`/`subscriptions`，`directory` = `dir`/`dirs`/`directories`，`overwrite` = `ow`

### 快捷命令

常用操作的快捷方式：

| 快捷命令               | 等效于                     |
| ---------------------- | -------------------------- |
| `mihomo-cli tun`           | `mihomo-cli start tun`         |
| `mihomo-cli use <name>`    | `mihomo-cli subscription use <name>` |
| `mihomo-cli restart`       | `mihomo-cli start`（start 本身即重启） |

## 模式说明

### Mixed 模式（默认）

- HTTP + SOCKS5 混合端口
- 由 launchd 服务托管，崩溃/登录自动拉起
- 需先 `mihomo-cli install`（一次），之后 `start`/`stop` 全程免密
- 需要手动配置应用代理

### TUN 模式（透明代理）

- 全局自动路由，所有流量自动走代理
- 临时进程，不走 launchd（用完 `mihomo-cli stop` 收掉）
- 需要 sudo / 管理员权限
- 首次使用会自动配置 DNS 和路由
- 与服务互斥：服务运行时会被拦下，需先 `mihomo-cli stop`

## 服务托管

Mixed 模式由 macOS 原生的 **launchd** 托管：内核崩溃、被系统 kill（如内存不足）、重新登录后都会自动拉起，无需手动 `start`。

```bash
mihomo-cli install         # 安装服务（只需一次，装完不启动）
mihomo-cli start           # 启动 + 开启登录自启
mihomo-cli stop            # 停止 + 关闭登录自启
mihomo-cli uninstall       # 卸载服务
mihomo-cli status          # 查看状态
```

**以上全部免密**。安装为用户级 LaunchAgent（`~/Library/LaunchAgents/`，`gui/<uid>` 域），不需要 root，因此日常启停不会打断你去输密码。

### 语义

| 命令 | 做了什么 | 重新登录后 |
| --- | --- | --- |
| `install` | 写 plist，**不启动** | 不启动 |
| `start` | `enable` + `bootstrap` | 自动启动 |
| `stop` | `bootout` + `disable` | **不启动** |
| `uninstall` | 停止 + 删 plist | 不启动 |

`stop` 会一并关闭自启，这是它与「杀掉进程」的区别——只停不关的话，下次登录代理又自己回来了，而 CLI 已经告诉你「已停止」。

> `uninstall` 只卸服务，订阅/内核/日志仍留在数据目录（重装后可继续用）。要彻底移除 mihomo-cli：`mihomo-cli reset --full` 删全部数据，再 `npm uninstall -g mihomo-cli`——`uninstall` 结束时也会提示这两步。
>
> **顺序别反**：先 `npm uninstall -g` 的话，LaunchAgent plist 会留下来，而能清理它的命令已经没了（plist 带 `KeepAlive`，仍会尝试拉起一个不存在的内核）。npm 现代版本**不会执行** uninstall 生命周期钩子（实测 npm 11.19.0 三种卸载场景均不触发，官方文档亦注明 uninstall lifecycle scripts 未实现），所以别指望卸载时看到任何提醒——按上面的顺序来。真反了也能救，手动执行：
>
> ```bash
> launchctl bootout gui/$(id -u)/com.mihomo-cli.daemon 2>/dev/null
> rm -f ~/Library/LaunchAgents/com.mihomo-cli.daemon.plist
> rm -rf ~/.mihomo-cli                     # 数据目录
> ```

- **`KeepAlive`** — 内核崩溃或被杀后由 launchd 自动拉起（约 10 秒节流后重启）
- **`RunAtLoad`** — 登录后自动启动
- 常驻的是系统 launchd 进程本身，**不额外占用资源、无轮询**
- 切换订阅、开关覆写后的重启**优先走内核热重载**，免密且不中断连接
- `start` 会确认内核**真的跑起来了**才报「已启动」：坏配置下内核启动即退出时报错并附日志尾部，而不是报成功后让 `KeepAlive` 静默地反复重试
- 「系统设置 → 通用 → 登录项与扩展」中显示为 **`mihomo-cli-service`**（plist 指向一个同名符号链，否则那里只会显示一个没有上下文的 `mihomo`）

### 关于 macOS 本地网络授权

服务以当前用户身份运行（不是 root）。macOS 15+ 对用户身份进程访问**局域网其他设备**有隐私限制：
首次连接时会弹出「允许访问本地网络」，点允许即可，之后永久生效，条目可在
「系统设置 → 隐私与安全性 → 本地网络」查看和开关。

**大多数人碰不到这个**：`127.0.0.1` / `::1` 属于 loopback，不出网卡，**不算本地网络**。
自己运行 `ssh -D 127.0.0.1:1080` 并把节点指向它，不受本地网络授权影响
只有节点直接指向 `192.168.x.x`、`10.x.x.x`、`*.local` 这类地址时才会触发。

服务始终以当前用户运行，局域网节点按 macOS 的授权流程处理

若 `/Library/LaunchDaemons` 仍有旧 root 服务，它可能持续自启并抢占端口；`install`/`uninstall`/`stop`/`tun` 和需要停机的 `reset` 会检测并清理，删除 root 文件时需要一次管理员密码

若确实有局域网节点且始终不弹框、连不通，本地网络授权**没有便捷的重置手段**（它不在 TCC 数据库里，
`tccutil reset LocalNetwork` 会直接失败），只能进恢复模式删 `/Library/Preferences/com.apple.networkextension.*.plist`，
且会清掉所有 App 的授权。遇到这种情况建议提 issue 说明场景。

另外，系统按代码签名与可执行文件 UUID 识别进程，而 mihomo 内核是 GitHub 下载的 Go 二进制（ad-hoc 签名），
**`mihomo-cli kernel` 更新内核后可能需要重新授权一次**。

### TUN 与服务共存

TUN 是临时模式，不走 launchd（本就需要 sudo，且用完即走）。两者会抢占同一组端口，因此服务运行时执行 `mihomo-cli tun` 会被拦下：

```bash
mihomo-cli stop      # 先停服务
mihomo-cli tun       # 起临时 TUN（需 sudo）
mihomo-cli stop      # 收掉 TUN
mihomo-cli start     # 恢复服务
```

**`mihomo-cli tun` 会自动关掉服务的登录自启**，并在启动时提示。原因是服务与 TUN 共用同一份运行时配置：TUN 一跑，那份配置就是 TUN 模式，而服务以普通用户身份运行、无权创建 TUN 设备。若自启还开着，用户不 `stop` 直接关机，下次开机 launchd 就会拿这份配置反复拉起一个必然失败的内核。

TUN 用完后 `mihomo-cli start` 会按 Mixed 重建配置并恢复自启。

**TUN 下 DNS 恒为开启**。若订阅或覆写里写了 `dns.enable: false`，TUN 模式会强制改回 `true` 并显示「配置提示」——TUN 会劫持 53 端口流量（`dns-hijack`），内置 DNS 关着就没有任何组件接管，网络直接不可用。只锁 `enable` 这一个键，`nameserver`、`enhanced-mode` 等仍按你的配置走。Mixed 模式不受影响，那里关 DNS 是合法配置。

### 不要用 sudo 运行

`sudo mihomo-cli …` 会被直接拒绝。服务是用户级 LaunchAgent（域 `gui/<uid>`），以 root 运行时域变成 `gui/0` —— 一个不存在的域，所有服务操作都会静默跳过却报成功。TUN 需要的 root 权限由 CLI 内部按需申请，无需在外层加 `sudo`。

### 日志

每次 `mihomo-cli start` 会把上一次的 `mihomo.log` 归档为 `mihomo.<时间戳>.log`，归档保留 7 天。运行期间日志持续追加到 `mihomo.log`；若单次运行就写超 10MB，配置变更触发的重启会顺便轮转，不会无限增长。

```bash
mihomo-cli logs         # 列出当前日志与归档
mihomo-cli logs 0 -f    # 实时跟随当前日志
mihomo-cli logs 1       # 查看最新的归档
```

## 内核更新通道

`mihomo-cli kernel` 按优先级自动选择下载通道，无需手动指定：

1. **本机代理**：mihomo-cli 代理在跑时经混合端口下载；速度过低或超时会快速失败并改由 gh 重试（仍经同一个本机代理——只换客户端不换路径，低速通常是节点问题）
2. **gh**：代理没跑，或代理通道失败时经 `gh release download` 下载
3. **直连**：以上都不可用时

镜像不持久化——每次按当前环境独立决策，换网络不会用到上次的镜像。

回退只换客户端、不换机场节点（url-test 通常仍选中同一个节点）；两条通道都因低速失败时，在面板里手动给 Default Proxy 换个线路后重试。

版本查询（GitHub API）在代理可用时直接经代理；无代理才走 **gh 认证通道**（配额 5000 次/时，未认证直连仅 60 次/时——共享出口 IP 撞 403 限流时 gh 是即时出路）。镜像**绝不**作用于 API——
内核二进制在 TUN 模式下会以 root 运行，下载地址必须由 GitHub 官方 API 给出，不能让镜像自己指定。

手动覆盖：

```bash
mihomo-cli kernel                # 自动选择通道
mihomo-cli kernel --mirror       # 强制走镜像（裸域 gh-proxy.org；不探测网络，纯 IPv6 网络请显式 v6）
mihomo-cli kernel --mirror v6    # 显式走 v6.gh-proxy.org
mihomo-cli kernel --mirror cdn   # 短别名指定镜像（cdn/v4/v6/axisnow）
mihomo-cli kernel --mirror hk.gh-proxy.org  # 任意镜像主机名或完整 URL
mihomo-cli kernel --mirror direct  # 强制直连（绕过 gh/代理自动通道）
mihomo-cli kernel --proxy 7897   # 经指定代理出网（纯端口视为 127.0.0.1:7897；mihomo-cli 没跑但本机有别的代理工具时用）
mihomo-cli kernel --proxy socks5://127.0.0.1:7897  # 完整代理地址；可与 --mirror 组合（镜像决定下载地址，代理只做传输）
```

> 镜像经第三方中转，无法验证来源完整性；gh 与本机代理通道直连 GitHub，优先使用。

**可用镜像：**

| 镜像                 | 短别名 | 说明                 |
| -------------------- | ------ | -------------------- |
| `gh-proxy.org`       | —      | 裸 `--mirror` 的默认主机 |
| `v6.gh-proxy.org`    | `v6`   | 纯 IPv6 网络显式指定 |
| `v4.gh-proxy.org`    | `v4`   | 强制 IPv4            |
| `cdn.gh-proxy.org`   | `cdn`  | CDN 节点             |
| `axisnow.gh-proxy.org` | `axisnow` |                  |

## 订阅自动更新

- 默认更新间隔：12 小时（订阅服务端可通过 `profile-update-interval` 覆盖）
- 触发时机：`start` 命令（`sub` 列表只读）
- **服务常驻期间不会自动更新**：launchd 只负责拉起内核，不会跑 `start`。`status` 会在订阅超过更新间隔时黄标提醒（`已超过 N 小时间隔，建议 mihomo-cli sub update`），此时手动跑 `mihomo-cli sub update` 或 `mihomo-cli start` 即可
- 更新失败时继续使用本地缓存，不影响使用
- 自动更新默认超时 10 秒，可通过 `-u <ms>` 调整；使用 `-s` 可完全跳过自动更新

## 选项写法

带值选项支持三种等价写法，长短选项对应关系：

| 短 | 长 | 用途 | 默认 |
| --- | --- | --- | --- |
| `-u` | `--update-timeout` | 启动时自动更新订阅超时（ms） | 10000 |
| `-n` | `--lines` | 日志显示行数 | 100 |

```bash
mihomo-cli start -u 30000            # 短选项 + 空格
mihomo-cli start --update-timeout 30000   # 长选项 + 空格
mihomo-cli start --update-timeout=30000   # 长选项 + 等号
```

布尔开关：`-s`（跳过订阅更新）、`--no-update`、`-y`/`--yes`（跳过确认）、`-o`（用系统默认程序打开）。

上述数值选项只接受 **>= 1 的整数**，非法值（`0`、负数、`5s`、`abc`）会直接报错而非静默取默认值——避免静默产出看似成功的错误结果。

## 数据保护

- **订阅内容校验**：下载到的内容必须含 `proxies` / `proxy-groups` / `proxy-providers` 之一才写盘。机场返回配额或错误 JSON（如 `{"error":"quota exceeded"}`）时报错并**保留磁盘上原有的可用配置**，不会被覆盖
- **`sub add` 失败回滚**：下载失败时移除半成品订阅，且不改动当前活跃订阅
- **`settings.json` 损坏恢复**：格式损坏（含合法 JSON 但非对象的情况）时自动备份为 `.bak` 并回退默认设置
- **运行配置校验**：启动或重载前，由已安装的 mihomo 内核执行 `-t` 校验；配置被拒绝时保留现有 `config.yaml`，不会自动删除错误节点、分组或规则
- **`reset` 停止确认**：需要停止进程的重置会先确认进程已终止，失败则中止删除

裸 `mihomo-cli reset` 清订阅、日志和运行数据，保留内核、覆写文件、其他设置及服务安装；`--full` 额外删除这些内容并卸载服务。指定多个目标时顺序不影响结果，`reset overwrites` 恢复覆写默认开启状态

## 数据目录

用户数据存储位置（与安装位置分离，更新不丢失）：

```
~/.mihomo-cli/
├── settings.json         # 用户设置（订阅列表、当前订阅、覆写开关、端口覆盖等）
├── settings.lock         # 设置读改写的跨进程锁
├── subscription-cache.lock  # 订阅缓存读改写的跨进程锁
├── service.lock          # 服务启停的跨进程锁
├── service-stop-epoch    # 并发启停的停止计数
├── overwrite.yaml        # 覆写配置（主文件，可选）
├── overwrite.*.yaml      # 覆写配置（扩展文件，如 overwrite.dns.yaml）
├── overwrite.js          # JS 覆写脚本（主脚本，可选；也认 .mjs / .cjs）
├── overwrite.*.js        # JS 覆写脚本（扩展脚本，在全部 YAML 覆写之前执行）
├── subscriptions/
│   ├── cache.json        # 订阅动态缓存（更新时间、流量、到期时间等）
│   └── <name>.yaml       # 订阅原始配置
├── kernel/
│   └── mihomo            # mihomo 内核二进制
├── logs/
│   ├── mihomo.log        # 当前日志
│   └── mihomo.YYYY-MM-DD_HH-MM-SS[.N].log  # 归档日志（同秒二次轮转加序号）
├── data/                 # mihomo 运行数据（GeoIP 等，由内核自行管理）
└── runtime/              # 运行时配置与临时文件
    ├── pid               # 进程 PID
    └── config.yaml       # 内核校验通过后的最终配置
```

可通过环境变量 `MIHOMO_CLI_DIR` 自定义数据目录位置。

其他环境变量：

| 变量 | 用途 |
| --- | --- |
| `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` | 非 macOS 上绕过平台守卫，仅供开发调试（功能不保证可用） |
| `MIHOMO_CLI_DAEMON_LABEL` | 覆盖服务 label，仅供隔离测试使用（随意改名会遗留无法管理的自启进程，日常勿设） |

## 覆写配置

覆写配置允许你在订阅配置基础上进行自定义修改，原始订阅文件保持独立

节点与分流规则按显式配置合并，最终交给 mihomo 校验。新增节点会按内核的 `include-all` / `include-all-proxies` 语义进入分组；需要排除时，在相应分组显式配置 `exclude-filter`

### 使用方法

1. 在 `~/.mihomo-cli/` 目录下创建覆写文件，两类按需混用：
   - `overwrite.yaml` — 主覆写文件（只认 `.yaml`；写成 `overwrite.yml` 不会被加载，CLI 会打一行提示）
   - `overwrite.dns.yaml` — 按功能拆分的扩展文件（`overwrite.*.yaml` / `overwrite.*.yml` 格式）
   - `overwrite.js` / `overwrite.*.js`（或 `.mjs` / `.cjs`）— JS 覆写脚本，可做任意编程化处理（见下文「JS 覆写脚本」）
2. 加载顺序：JS 脚本全部在前（`overwrite.js` 最先，扩展脚本按文件名排序），YAML 在后（`overwrite.yaml` 最先，扩展文件按文件名排序）——脚本做程序化结构变换，YAML 在其产出上做声明式微调（如 `+rules` 前插的规则永远在最前，不受脚本重组影响）
3. 覆写**默认即启用**，放好文件后重启生效（`mihomo-cli start`）；如曾 `ow off` 禁用过，用 `mihomo-cli ow on` 重新启用（会自动重启）

### 特殊语法（YAML）

YAML 覆写支持以下操作符，**只在覆写文件的顶层生效**：

| 语法     | 作用                                      | 示例                 |
| -------- | ----------------------------------------- | -------------------- |
| `key!`   | 强制覆盖整个对象（不深度合并）            | `dns!`: { ... }      |
| `+key`   | 数组前置插入                              | `+proxies`: [...]    |
| `key+`   | 数组追加                                  | `rules+`: [...]      |

普通键（无操作符）对映射做逐键深度合并、对数组整体替换。带条件的修改（按 `name` 找元素、改部分字段、找不到时跳过或追加之类）不设操作符——那是有逻辑的变换，写 JS 脚本表达（见下文），意图直接写在代码里。

> 历史版本曾有 `~key` / `~?key`（按 name 合并数组元素）与 `<key>` 尖括号转义，已移除：现在写这些形态会直接报错并提示改用 JS 脚本，不会被静默当成字面键名。

**嵌套层（映射里的映射）的键一律按字面名合并**，`+` / `!` 在那里不是操作符——mihomo 原生配置的键名本来就可能带这些符号（如 `nameserver-policy`、`hosts` 里的 `+.域名` 通配键），直接照写即可：

```yaml
dns:
  nameserver-policy:
    '+.corp.example.com': 'https://dns.corp.example.com/dns-query'
hosts:
  '+.google.cn': 8.8.8.8
```

嵌套映射的普通键仍逐键深度合并；要改嵌套的数组（如 `dns.nameserver`）请写全量值（普通键整体替换）。

> `+key` / `key+` 是**数组语义**：若目标键已存在且不是数组（如 `log-level+` 作用于字符串），会直接报错而非静默包成单元素数组——后者会生成 mihomo 无法解析的配置。要覆盖非数组值请用 `key!`（强制覆盖）或直接写 `key`（深度合并）。

### JS 覆写脚本

YAML 操作符只保留最简单的三种，其余一律写脚本自由处理。脚本是一个默认导出的函数，**就地修改**传入的 `config`（订阅解析后的配置），返回值忽略；YAML 覆写在全部脚本之后才声明式合并：

```js
// ~/.mihomo-cli/overwrite.custom.js
export default function (config, ctx) {
  // 把订阅下发的 Developer 分组默认选中改为 TW Fixed IP；
  // 该分组不存在时跳过并提示（不用为它改 match 作用域）
  const groups = config['proxy-groups'] || [];
  const developer = groups.find(g => g && g.name === 'Developer');
  if (developer) {
    developer['default-selected'] = 'TW Fixed IP';
  } else {
    ctx.warn('当前订阅无 Developer 分组，跳过 default-selected 注入');
  }
}
```

`ctx` 提供的上下文：

| 字段 | 内容 |
| ---- | ---- |
| `ctx.subscription.name` | 当前订阅名 |
| `ctx.subscription.url` | 订阅原始 URL |
| `ctx.subscription.host` | 预解析的 URL hostname（解析失败为空串），按域名限定作用域时用它 |
| `ctx.mode` | 本次构建的运行模式：`'mixed'` 或 `'tun'` |
| `ctx.warn(message)` | 发一条提示进 warnings 通道，`config` / `doctor` / `start` 的输出可见（`status` 走诊断旁路、不执行脚本，看不到） |

约定与边界：

- **必须同步**：返回 Promise 会报错。脚本是纯数据变换，没有要等网络的场景
- **全信任**：脚本以你的用户身份运行（和 `.zshrc` 一个待遇），不做沙箱与超时——别装来路不明的覆写脚本
- **改不动系统锁定项**：`mixed-port`、`external-controller`、`allow-lan` 等入站与控制面键由 CLI 管理，脚本设置了会被剥除并提示（与 YAML 覆写同一条边界）
- **脚本先于 YAML 执行**：脚本看到的是订阅原始配置，读不到 YAML 覆写注入的内容；需要脚本处理 YAML 注入项时，把那段逻辑也写进脚本
- **只读命令也会加载脚本**：`ow` / `status` 扫描文件时会加载脚本，模块顶层代码随之执行（顶层只定义函数，变换都在导出函数里做）；导出的变换函数在 `config` / `doctor` / `start` 构建时才调用，`status` 不调用、也不显示它的 `ctx.warn`
- 加载失败（语法错误、缺少导出、顶层抛错）与坏 YAML 同款姿态：`ow` / `status` 里「加载失败」可见，`config` / `start` / `doctor` 硬失败并带文件名；变换函数执行中抛错只在后三者报出（`ow` / `status` 不执行函数体）
- 脚本受 `mihomo-cli ow off` 全局开关管理；想临时停用单个脚本，改个扩展名（如 `.bak`）即可

### 作用域限定（match）

在覆写文件顶部加 `match:` 块，可让该文件**只对指定订阅生效**（无 `match` 则全局生效）。所列条件需全部满足（AND），条件值为数组时其内部为 OR：

| 匹配键        | 作用                          |
| ------------- | ----------------------------- |
| `name`         | 按订阅名匹配，支持尾部 `*`（前缀）与头部 `*`（后缀）两种通配（大小写不敏感，与 `sub use` 口径一致） |
| `url-domain`   | 按订阅 URL 的 hostname 后缀匹配（字面比对，无通配） |

订阅名只支持两种通配形态，其余（多 `*`、中间 `*`、`?`、单独 `*`）报错——更复杂的匹配写 JS 脚本（`ctx.subscription.name` 自己判）：

| 写法 | 命中 | 不命中 |
| ---- | ---- | ------ |
| `edu*` | `edu1`、`edu2`、`edu-hk` | `mini1`、`xedu1`（前缀不越过串首） |
| `"*edu"` | `miniedu` | `edu1`（后缀不越过串尾） |
| `edu1` | `edu1` | `edu10`（无通配符时就是精确匹配） |

> **以 `*` 开头的值必须加引号**：YAML 里 `*` 开头是别名语法，`name: *edu` 会解析失败、整个文件被跳过（CLI 会提示加引号）。写成 `name: "*edu"` 即可。结尾的 `*`（`edu*`）不受影响

`match` 块**写错会直接报错**（键名拼错、值为空、空块、写已移除的 `subscription` 键），而不是静默忽略后对所有订阅生效——写了 `match` 显然是想限定作用域，悄悄放宽比报错危险得多。历史写法 `subscription` 与 `name` 同义、已收掉，写它直接报错指明改写 `name`。

> `url-domain` 命中该域名下的**所有**订阅。同一机场的多条订阅（如 `edu1`、`mini1`）URL 往往同域名，用 `url-domain` 会一并生效；要在同机场内按套餐区分，用 `name: edu*`。若只是担心某条订阅没有要改的分组，在 JS 脚本里判（找不到就 `ctx.warn` 跳过），不必为此改作用域；`match` 应当按「这份覆写在语义上属于哪些订阅」来写。JS 脚本没有 match 机制——作用域判断写在脚本开头（`if (!ctx.subscription.name.startsWith('edu')) return;`）。

`mihomo-cli status` 会按当前活跃订阅区分「生效」与「不适用」，括号里只列本次真正参与合并的文件：

```text
覆写: 已启用 (seal，1 个不适用，1 个已禁用)
  glados 不适用于当前订阅 mini1（作用域 name=edu*）
```

「不适用」指文件本身是启用的，只是 `match` 没命中当前订阅——切到命中的订阅（`sub use`）或改 `match` 才会生效，与 `enabled: false` 的「已禁用」是两回事。`mihomo-cli ow` 列表不做这个判断（它不绑定某条订阅），那里的作用域一栏只说明该文件管哪些订阅。`--json` 形态下 `overwrite.applied` 是生效清单（`ow off` 全局关闭时为空数组），`overwrite.files` 仍是「未被 `enabled: false` 停用」的全部文件；语法或元数据键写错的文件进 `overwrite.errors`（不混进 files/applied）。

**坏文件不阻断诊断、但阻断启动**：YAML 语法错误（含 `enabled: no` 这类元数据键错误）的文件在 `mihomo-cli ow` 与 `status` 中以「加载失败」红字标出，诊断命令永远可用；但该文件不参与合并，`mihomo-cli start`/`doctor` 会硬失败并给出原因——曾经语法错只警告一行就跳过、退出码 0，启动成功但覆写根本没生效。

### 单个文件的开关（enabled）

在覆写文件顶部写 `enabled: false`，可**只停用这一个文件**，其余覆写照常生效：

```yaml
# ~/.mihomo-cli/overwrite.seal.yaml
enabled: false    # 暂时停用这份覆写，不用改名或删除

+proxies:
  - name: Seal-Host
    type: socks5
    server: 127.0.0.1
    port: 1080
```

- 不写该键即启用；被停用的文件**仍会出现在 `mihomo-cli ow` 列表里**并标注 `[已禁用]`（改名成 `.bak` 则会从列表里消失，不知道自己还有这份配置）
- 与 `mihomo-cli ow off` 是两层：后者是全局总开关，一次关掉所有覆写
- **必须写 `false`，不能写 `no` / `off`**：YAML 里这两个是字符串而非布尔值，CLI 会直接报错而不是按「真值」放行——否则你以为停用了、配置却照常生效
- `enabled` 与 `match` 同属元数据键，不会进入最终的 mihomo 运行配置；它们**不接受操作符，也必须小写**（`enabled!`、`+match`、`Enabled` 都会直接报错——那些写法既不停用文件，还会把键当普通配置写进运行配置，而内核对未知顶层键不报错、你不会收到任何提示）

### 示例

```yaml
# ~/.mihomo-cli/overwrite.yaml

# 强制覆盖 dns 配置
dns!:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 223.5.5.5

# 将规则放到订阅规则之前，避免被已有 MATCH 提前匹配
+rules:
  - 'DOMAIN-SUFFIX,example.com,DIRECT'
```

```yaml
# ~/.mihomo-cli/overwrite.dns.yaml
# dns! 强制覆盖整个对象（不与订阅的 dns 深度合并）
dns!:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 223.5.5.5

# 将规则放到订阅规则之前，避免被已有 MATCH 提前匹配
+rules:
  - 'DOMAIN-SUFFIX,example.com,DIRECT'
```

```js
// ~/.mihomo-cli/overwrite.glados.js
// 只对该机场 edu 系列的订阅生效：把订阅下发的 Developer 分组默认选中改为 TW Fixed IP。
// 作用域与「分组不存在则跳过」都写在代码里——JS 脚本没有 match 机制
export default function (config, ctx) {
  const { name, host } = ctx.subscription;
  if (!name.startsWith('edu')) return;                       // 同机场的 mini1 不命中
  if (host !== 'glados-config.com' && !host.endsWith('.glados-config.com')) return;
  const developer = (config['proxy-groups'] || []).find(g => g && g.name === 'Developer');
  if (developer) {
    developer['default-selected'] = 'TW Fixed IP';
  } else {
    // 精简套餐没有该分组：提示并跳过，不追加残缺分组
    ctx.warn('当前订阅无 Developer 分组，跳过 default-selected 注入');
  }
}
```

> 注：`default-selected` 由 mihomo 内核决定默认选中项，优先级低于 `store-selected` 缓存的历史选择。若之前手动选过、且开启了 `store-selected`，需 `mihomo-cli reset data` 清缓存后才能看到默认值接管。

### 同时使用多个机场

本 CLI 是单活跃订阅模型（`sub use` 切换），不合并多条订阅。要把第二个机场的节点并进当前订阅，用覆写引入 mihomo 原生的 `proxy-providers`——节点池由内核按 `interval` 自动刷新，不受单订阅模型限制：

```yaml
# ~/.mihomo-cli/overwrite.providers.yaml
proxy-providers:
  second-airport:
    type: http
    url: https://second-airport.example.com/api/v1/client/subscribe?token=xxx
    interval: 86400              # 节点池自动刷新间隔（秒）
    path: ./second-airport.yaml  # 缓存文件（mihomo 管理，相对 data 目录）
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

# 新增一个走第二机场的分组（+ 是数组前置插入，订阅分组不动）
+proxy-groups:
  - name: SecondAirport
    type: select
    use: [second-airport]

# 在订阅规则之前分流到该分组
+rules:
  - 'DOMAIN-SUFFIX,corp.example.com,SecondAirport'
```

provider 节点与订阅节点同池参与分组选择；节点延迟与手动切换在 Web UI（`mihomo-cli ui`）里操作。若想让订阅里已有的某个分组也纳入第二机场的节点，写 JS 脚本按 name 找到该分组、加 `use` 字段（找不到时 `ctx.warn` 跳过——订阅里没有该分组时不该新建一个残缺分组）

### 用 ssh -D 做节点

先运行 `ssh -D 127.0.0.1:1080 -N host`，再把本地端口作为 socks5 节点写进覆写：

```yaml
# ~/.mihomo-cli/overwrite.ssh.yaml
'proxies+':
  - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
+rules:
  - DOMAIN-SUFFIX,example.internal,SSH-work
```

## Web UI

内置三个常用 Web UI：

| 名称 | 地址                                     | 说明                 |
| ---- | ---------------------------------------- | -------------------- |
| zash | <https://board.zash.run.place>           | 现代简洁界面（默认） |
| dash | <https://metacubex.github.io/metacubexd> | MetaCubeX 官方 UI    |
| yacd | <https://yacd.metacubex.one>             | 经典 YACD 界面       |

## 故障排除

### 一键体检

```bash
mihomo-cli doctor
```

逐项检查内核可执行性、数据目录可写、settings 有效性（含端口覆盖合法性）、订阅配置与新鲜度、服务状态、端口占用、
配置的内核原生校验、代理连通性、内核版本（落后时提示 `mihomo-cli kernel`）、CLI 版本（落后时提示 `mihomo-cli update`）；
两个版本检查都访问网络，GitHub/npm 不可达则跳过、不算异常。每项给出 ✓/!/✗ 与修复命令；
存在异常项时退出码为 1（警告不影响退出码）。

### 启动失败

`mihomo-cli start` 先用内核检查候选配置，错误会直接显示并保留现有运行配置。CLI 不再自动修复重名节点或失效引用，需要修改订阅或覆写后重试

内核只报「哪个键不合法」，说不出「这个键是覆写加进来的」，所以提示里会附上本次实际生效的覆写文件与作用域：

```
配置错误: 内核拒绝加载配置

  ProxyGroup Developer: '' has unset fields: type

  当前生效的覆写文件:
    overwrite.glados.yaml (url-domain=glados-config.com)
    overwrite.seal.yaml (全局)
  若报错的元素来自覆写（YAML 追加或 JS 脚本注入），检查对应的覆写文件与脚本。

  请修正订阅或覆写；当前运行时配置未改动。
```

清单已按 `ow` 开关、文件内 `enabled` 与 `match` 过滤，即**本次真正参与合并**的文件；`(全局)` 表示该文件没有 `match`、对所有订阅生效，有 `match` 时按你写的键名回显（如 `name=edu*`）。没有覆写生效时不显示这一段（问题就在订阅本身）。`mihomo-cli doctor` 给出同样的信息，`mihomo-cli ow` 可看全部覆写文件（含被停用的）

校验通过后仍需确认内核已运行：端口占用、系统权限等启动问题会报错并附日志尾部，退出码非 0。异常退出原因与 `status` 使用同一口径（`退出码 N` 或 `被信号终止（Killed: 9）`）

```bash
mihomo-cli logs 0        # 看完整原因
mihomo-cli stop          # 止住 launchd 的反复重试
```

若 `status` 显示「不在运行」但带「内核上次异常退出」的提示，说明内核正在崩溃循环中被反复拉起，同样按上面两步处理。提示会区分两种死法：`退出码 N`（内核自己退的，多为配置问题）与 `被信号终止（Killed: 9）`（被外部杀掉，常见于系统内存不足时被 OOM killer 干掉）。

### 进程无法停止

```bash
sudo pkill -9 mihomo
```

### TUN 模式无法启动

1. 运行 `mihomo-cli tun`，按提示提供管理员密码，无需在命令前加 sudo
2. 检查是否有其他程序占用 53 端口
3. 查看日志：`mihomo-cli logs 0 -f`

### 订阅更新失败

- 检查网络连接
- 确认订阅 URL 有效且未过期
- URL 中的 token 等敏感信息会自动脱敏

### 端口被占用

默认端口（CLI 强制，不受订阅/覆写影响）：

- 混合端口 (HTTP + SOCKS5): `7890`
- 外部控制器: `127.0.0.1:9090`

与其他代理工具冲突或需要并存时，可在 `settings.json` 中覆盖端口（两键均可选，需为 1-65535 的整数且互不相同）：

```json
{
  "ports": { "mixed": 17890, "controller": 19090 }
}
```

改动后 `mihomo-cli start` 重新生成配置即生效；Web UI 连接地址与系统代理里的端口请使用新值（`mihomo-cli status` 会显示实际端口）

## 安全特性

- **URL 脱敏**：订阅 URL 中的 token、key、password 等敏感参数（含 query、userinfo 及路径型令牌）自动替换为 `***`。按整条 URL 处理、不按逗号切分——逗号在 query 中合法，切开会让 `?nodes=us,hk&token=xxx` 的 token 参数识别不出而明文输出
- **文件权限**：配置文件使用 `0o600` 权限（仅所有者可读可写），目录使用 `0o700` 权限
- **入站固定只监听回环**：`allow-lan` 由本工具恒定为 `false`，**订阅与覆写都改不了**（自 v4.13.0；此前订阅里写 `allow-lan: true` 即可把混合端口开到全网卡）。确需局域网设备连入的场景请在本机另起一个 mihomo 实例，不通过订阅投递
- **入站与控制面由本工具独占**：订阅与覆写里的入站端口（`mixed-port`/`port`/`socks-port`/`redir-port`/`tproxy-port`）、独立入站服务端（`tuic-server`/`ss-config`/`vmess-config`）、通用入站声明（`listeners`/`tunnels`）、局域网暴露与入站鉴权（`allow-lan`/`bind-address`/`authentication`/`skip-auth-prefixes`/`lan-allowed-ips`/`lan-disallowed-ips`）、外部控制器全家桶（`external-controller*`、`external-doh-server`、`secret`、`external-ui*`）与控制器证书段（`tls`）一律剥除，不进运行配置。这些键要么自带监听地址、要么直接决定「监听在哪、要不要验身份」，远端订阅若能投递即可在全网卡开出无鉴权控制器或开放代理——`allow-lan: true` 让内核把端口绑到所有网卡，而 `skip-auth-prefixes: ["0.0.0.0/0"]` 会让唯一的补偿防线 `authentication` 整个失效；端口与密钥只认 `settings.json`。覆写文件里写了会有提示，订阅侧静默剥除。确需额外入站的场景请在本机另起一个 mihomo 实例，不通过订阅投递
- **信号处理**：优雅处理 SIGINT/SIGTERM 信号
- **异常捕获**：全局 uncaughtException 和 unhandledRejection 处理

> **注意**：外部控制器（`127.0.0.1:9090`）默认无鉴权，与 Clash 系工具惯例一致。它仅监听本机回环、局域网不可达；但本机其他进程（含浏览器中的网页）可访问它，请勿在不可信的多用户环境使用。
>
> 多用户环境可在 `settings.json` 中设置 `controller_secret`（写入配置后随启动生效，`ui` 命令会提示密钥），为控制器 API 加上 Bearer 认证；密钥由系统锁定，订阅/覆写无法伪造。

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。

## 相关项目

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) - mihomo 内核
- [MetaCubeX/metacubexd](https://github.com/MetaCubeX/metacubexd) - Web UI
- [MetaCubeX/Yacd-meta](https://github.com/MetaCubeX/Yacd-meta) - YACD Web UI

## 免责声明

本工具仅供学习和研究使用。使用本工具时请遵守当地法律法规。
