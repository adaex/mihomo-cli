# mihomo-cli

一个基于命令行的 mihomo (Clash.Meta) 客户端，**仅支持 macOS**。

服务托管依赖 launchd、目录/UI 打开依赖 `open`、提权依赖 `sudo`，均无其他平台实现，故在非 macOS 上会直接报错退出而非部分可用。Windows / Linux 适配尚无时间表。

## 功能特性

- 🌐 **订阅管理** - 添加/更新订阅，支持流量统计和到期时间显示
- 🔄 **自动更新** - 启动时自动检查并更新过期订阅
- 🔍 **模糊匹配** - `sub use` / `update` / `remove` 均支持订阅名称模糊匹配（大小写不敏感）
- 📝 **覆写配置** - 在订阅基础上进行自定义覆写，支持强制覆盖、数组合并、按 name 就地 patch、按订阅限定作用域
- 🔄 **智能重启** - `sub use` 切换订阅、`ow on/off` 切换覆写后自动重启
- 🚀 **进程管理** - 启动/停止/切换模式，自动清理残留进程
- 🛡️ **服务托管** - 基于 launchd，崩溃/登录自动拉起，代理后台常驻；日常 `start`/`stop` **全程免密**
- 🔄 **双模式支持** - Mixed 模式和 TUN 透明代理模式
- 📊 **状态监控** - 查看运行状态、内存占用、订阅流量、到期时间与更新新鲜度（紧急度着色，`--json` 机器可读）
- 🩺 **体检诊断** - `mihomo doctor` 一键检查内核/服务/端口/订阅/配置/连通性/CLI 版本并给修复指引
- 🔌 **端口逃生口** - 默认 7890/9090 可经 `settings.json` 的 `ports` 覆盖，与其他代理工具并存
- 🔌 **连通性探测** - 启动与状态展示独立确认「代理真的通」，不通时归因到订阅过期/流量用尽/节点失效
- ⌨️ **Shell 补全** - `mihomo completion zsh|bash|fish` 生成补全脚本
- 📝 **日志管理** - 每次启动归档上一次日志，保留 7 天，支持列表/跟随/编号查看
- 🎨 **Web UI** - 一键打开 Web 控制面板 (zash/metacubexd/yacd)
- 🔄 **内核更新** - 自动检查更新，支持 GitHub 镜像加速
- 💡 **容错提示** - 命令/子命令拼错时给出 did-you-mean 纠错建议
- ⌨️ **命令别名** - `mihomo` / `mhm` / `mh` 均可调用

## 安装

### 方式一：npm 全局安装

```bash
npm install -g mihomo-cli
```

### 方式二：源码安装

```bash
git clone https://github.com/adaex/mihomo-cli.git
cd mihomo-cli
npm install
npm run build
npm link
```

## 快速开始

> 全新环境直接运行 `mihomo`（不带参数）会显示状态与「开始使用」引导：缺哪步列哪步。

### 1. 下载内核

```bash
# 自动选择通道：gh > 本机代理 > 直连
mihomo kernel

# 国内网络强制走镜像（有 IPv6 走 v6，否则裸域）
mihomo kernel --mirror

# 或用短别名指定镜像
mihomo kernel --mirror cdn
```

### 2. 添加订阅

```bash
mihomo sub add "https://your-subscription-url" "my-proxy"

# 或先在机场页面复制订阅链接，再运行（交互下自动读取剪贴板，确认后添加）
mihomo sub add
```

### 3. 安装服务

```bash
mihomo install
```

Mixed 模式由 launchd 服务托管（崩溃/登录自动拉起），只需装这一次。全程免密，详见「服务托管」。

### 4. 启动代理

```bash
# Mixed 模式（默认），同时开启登录自启
mihomo start

# 再次执行 start = 重启并应用新配置
mihomo start

# 停止并关闭登录自启
mihomo stop

# 临时 TUN 透明代理（不走服务，需管理员权限）
mihomo tun
```

### 5. 打开 Web UI

```bash
mihomo ui          # 默认 zash
mihomo ui dash     # metacubexd
mihomo ui yacd     # YACD
```

## 命令参考

### 核心命令

| 命令                        | 说明                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `mihomo install`            | 安装服务（Mixed 模式的前置，只需一次；升级用户会顺带清理旧的 root 服务）      |
| `mihomo start [tun\|mixed]` | 启动代理并开启登录自启（`-s` 跳过订阅更新，`-u` 更新超时） |
| `mihomo stop`               | 停止代理并关闭登录自启                                                       |
| `mihomo uninstall`          | 卸载服务                                                                     |
| `mihomo status`             | 查看运行状态（含订阅流量、到期、更新新鲜度；`--json` 机器可读，`--no-probe` 跳过连通性探测）             |
| `mihomo logs`               | 列出所有日志（当前 + 历史归档）                                              |
| `mihomo logs <编号>`        | 查看指定日志（`0`=当前，`1+`=归档，`-f` 实时跟随，`-n N` 行数，`-o` 打开）  |
| `mihomo logs -f`            | 跟随当前日志（省略编号时默认当前，等价 `logs 0 -f`）                        |

### 订阅管理

| 命令                          | 说明                                   |
| ----------------------------- | -------------------------------------- |
| `mihomo sub`                  | 列出所有订阅（含流量、到期时间）       |
| `mihomo sub use <name>`       | 切换当前订阅（支持模糊匹配，自动重启） |
| `mihomo sub add [url] [name]` | 添加订阅并自动切换（名称不可重复；交互下不带 URL 时自动读剪贴板并确认） |
| `mihomo sub update`           | 更新所有订阅                           |
| `mihomo sub update <name>`    | 更新指定订阅（支持模糊匹配）           |
| `mihomo sub remove <name>`    | 删除订阅（别名 `rm`/`delete`；精确名直接删，模糊匹配需确认，`-y` 跳过） |

> 节点测速请用 `mihomo ui` 打开的 Web 面板（zash/metacubexd/yacd 均内置逐节点实时测延迟），
> 或直接在订阅里配置 `url-test` 分组由内核自动选路——两者都比一次性的命令行快照更实时。

### 覆写配置

| 命令                           | 说明                       |
| ------------------------------ | -------------------------- |
| `mihomo ow`                  | 查看覆写配置状态和文件列表（别名 `enable`/`disable` 亦可用于开关） |
| `mihomo ow on`                   | 启用覆写配置（**默认已启用**，自动重启）                          |
| `mihomo ow off`                  | 禁用覆写配置（自动重启）                                          |

### 其他命令

| 命令                              | 说明                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `mihomo kernel [--mirror [镜像]]` | 更新内核（自动选择通道：gh > 本机代理 > 直连；`--mirror` 强制镜像，`--mirror direct` 强制直连） |
| `mihomo update`                   | 更新 mihomo-cli（先查 npm 最新版，已是最新则跳过重装）              |
| `mihomo ui [zash\|dash\|yacd]`    | 打开 Web UI（配了访问密钥时自动复制到剪贴板）                       |
| `mihomo dir`                      | 显示数据目录位置                                                    |
| `mihomo dir open [target]`        | 打开指定目录（`root`, `subs`, `logs`, `data`, `runtime`, `kernel`）  |
| `mihomo reset [目标...] [--full] [-y]` | 重置用户数据（可用目标：`subs`, `logs`, `data`, `runtime`, `settings`, `kernel`, `overwrites`, `service`；`--full` 删全部，`-y` 跳过确认） |
| `mihomo doctor`                   | 体检诊断（内核/服务/端口/订阅/配置/连通性/CLI 版本，有异常退出码 1） |
| `mihomo completion install <shell>` | 安装 shell 补全到默认位置（`zsh`/`bash`/`fish`）                |
| `mihomo completion <shell>`       | 输出 shell 补全脚本（重定向或 eval 使用）                           |
| `mihomo version`                  | 显示版本信息                                                        |
| `mihomo help`                     | 显示帮助信息                                                        |

### 命令别名

以下任意命令等效：

- `mihomo-cli` (原名)
- `mihomo`
- `mhm`
- `mh`

子命令组亦有别名：`subscription` = `sub`/`subs`/`subscriptions`，`directory` = `dir`/`dirs`/`directories`，`overwrite` = `ow`

### 快捷命令

常用操作的快捷方式：

| 快捷命令               | 等效于                     |
| ---------------------- | -------------------------- |
| `mihomo tun`           | `mihomo start tun`         |
| `mihomo use <name>`    | `mihomo subscription use <name>` |
| `mihomo restart`       | `mihomo start`（start 本身即重启） |

> `up` / `down` 别名已于 v4.1.0 移除（命令名统一为 `install`/`start`/`stop`/`uninstall`）。执行它们会给出明确的迁移提示。

## Shell 补全

```bash
# 一键安装到对应 shell 的默认补全位置（推荐）
mihomo completion install zsh     # → ~/.zsh/completions/_mihomo
mihomo completion install bash    # → 追加到 ~/.bash_completion（幂等，不覆盖已有内容）
mihomo completion install fish    # → ~/.config/fish/completions/mihomo.fish

# 或临时启用（不落盘）
eval "$(mihomo completion zsh)"   # bash 同理
mihomo completion fish | source
```

> zsh 的 `~/.zsh/completions` 不在默认 `fpath` 里（oh-my-zsh 默认已包含）：
> 补全不生效时在 `~/.zshrc` 加一行 `fpath=(~/.zsh/completions $fpath)`，重新打开终端。

覆盖全部命令、订阅/覆写/目录子命令与常用选项（`logs` 的 `-f`/`-n`、`kernel` 的 `--mirror` 等）。

## 模式说明

### Mixed 模式（默认）

- HTTP + SOCKS5 混合端口
- 由 launchd 服务托管，崩溃/登录自动拉起
- 需先 `mihomo install`（一次），之后 `start`/`stop` 全程免密
- 需要手动配置应用代理

### TUN 模式（透明代理）

- 全局自动路由，所有流量自动走代理
- 临时进程，不走 launchd（用完 `mihomo stop` 收掉）
- 需要 sudo / 管理员权限
- 首次使用会自动配置 DNS 和路由
- 与服务互斥：服务运行时会被拦下，需先 `mihomo stop`

## 服务托管

Mixed 模式由 macOS 原生的 **launchd** 托管：内核崩溃、被系统 kill（如内存不足）、重新登录后都会自动拉起，无需手动 `start`。

```bash
mihomo install         # 安装服务（只需一次，装完不启动）
mihomo start           # 启动 + 开启登录自启
mihomo stop            # 停止 + 关闭登录自启
mihomo uninstall       # 卸载服务
mihomo status          # 查看状态
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

> `uninstall` 只卸服务，订阅/内核/日志仍留在数据目录（重装后可继续用）。要彻底移除 mihomo-cli：`mihomo reset --full` 删全部数据，再 `npm uninstall -g mihomo-cli`——`uninstall` 结束时也会提示这两步。

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
自己起 `ssh -D 127.0.0.1:1080` 再把节点指过去（v4.0.0 移除内置 ssh 后推荐的做法）完全不受影响。
只有节点直接指向 `192.168.x.x`、`10.x.x.x`、`*.local` 这类地址时才会触发。

> **为什么不用 root 服务绕开**：早期版本（v3.0–v4.0）确实用 root LaunchDaemon 绕开了这个限制
> （Apple 的规则是「以 root 运行的程序自动获得本地网络访问」——豁免条件是 root，而非「是不是 daemon」），
> 代价是每次 `start`/`stop` 都要输管理员密码。权衡后选择免密：授权点一次，密码要输一辈子。
>
> 从旧版本升级的用户若还留着 root 安装（`~/Library/LaunchDaemons` 下带 KeepAlive 的幽灵，会抢端口且停不掉），
> `install`/`uninstall`/`stop`/`tun`/`reset` 检测到它都会引导清理——清理要删 root 属主的文件，需要输一次管理员密码。

若确实有局域网节点且始终不弹框、连不通，本地网络授权**没有便捷的重置手段**（它不在 TCC 数据库里，
`tccutil reset LocalNetwork` 会直接失败），只能进恢复模式删 `/Library/Preferences/com.apple.networkextension.*.plist`，
且会清掉所有 App 的授权。遇到这种情况建议提 issue 说明场景。

另外，系统按代码签名与可执行文件 UUID 识别进程，而 mihomo 内核是 GitHub 下载的 Go 二进制（ad-hoc 签名），
**`mihomo kernel` 更新内核后可能需要重新授权一次**。

### TUN 与服务共存

TUN 是临时模式，不走 launchd（本就需要 sudo，且用完即走）。两者会抢占同一组端口，因此服务运行时执行 `mihomo tun` 会被拦下：

```bash
mihomo stop      # 先停服务
mihomo tun       # 起临时 TUN（需 sudo）
mihomo stop      # 收掉 TUN
mihomo start     # 恢复服务
```

**`mihomo tun` 会自动关掉服务的登录自启**，并在启动时提示。原因是服务与 TUN 共用同一份运行时配置：TUN 一跑，那份配置就是 TUN 模式，而服务以普通用户身份运行、无权创建 TUN 设备。若自启还开着，用户不 `stop` 直接关机，下次开机 launchd 就会拿这份配置反复拉起一个必然失败的内核。

TUN 用完后 `mihomo start` 会按 Mixed 重建配置并恢复自启。

**TUN 下 DNS 恒为开启**。若订阅或覆写里写了 `dns.enable: false`，TUN 模式会强制改回 `true` 并提示一行「自动修复」——TUN 会劫持 53 端口流量（`dns-hijack`），内置 DNS 关着就没有任何组件接管，网络直接不可用。只锁 `enable` 这一个键，`nameserver`、`enhanced-mode` 等仍按你的配置走。Mixed 模式不受影响，那里关 DNS 是合法配置。

### 不要用 sudo 运行

`sudo mihomo …` 会被直接拒绝。服务是用户级 LaunchAgent（域 `gui/<uid>`），以 root 运行时域变成 `gui/0` —— 一个不存在的域，所有服务操作都会静默跳过却报成功。TUN 需要的 root 权限由 CLI 内部按需申请，无需在外层加 `sudo`。

### 日志

每次 `mihomo start` 会把上一次的 `mihomo.log` 归档为 `mihomo.<时间戳>.log`，归档保留 7 天。运行期间日志持续追加到 `mihomo.log`；若单次运行就写超 10MB，配置变更触发的重启会顺便轮转，不会无限增长。

```bash
mihomo logs         # 列出当前日志与归档
mihomo logs 0 -f    # 实时跟随当前日志
mihomo logs 1       # 查看最新的归档
```

## 内核更新通道

`mihomo kernel` 按优先级自动选择下载通道，无需手动指定：

1. **gh**：检测到 GitHub CLI（`gh`）时，经 `gh release download` 直连 GitHub
2. **本机代理**：mihomo 代理在跑时，经混合端口直连 GitHub（TLS 端到端）
3. **直连**：以上都不可用时

镜像不持久化——每次按当前环境独立决策，换网络不会用到上次的镜像。

版本查询（GitHub API）在代理开着时同样经本机代理；镜像**绝不**作用于 API——
内核二进制随后会以 root 运行（TUN/保活），下载地址必须由 GitHub 官方 API 给出，不能让镜像自己指定。

手动覆盖：

```bash
mihomo kernel                # 自动选择通道
mihomo kernel --mirror       # 强制走镜像（有 IPv6 走 v6.gh-proxy.org，否则 gh-proxy.org）
mihomo kernel --mirror cdn   # 短别名指定镜像（cdn/v4/v6/axisnow）
mihomo kernel --mirror hk.gh-proxy.org  # 任意镜像主机名或完整 URL
mihomo kernel --mirror direct  # 强制直连（绕过 gh/代理自动通道）
```

> 镜像经第三方中转，无法验证来源完整性；gh 与本机代理通道直连 GitHub，优先使用。

**可用镜像：**

| 镜像                 | 短别名 | 说明                 |
| -------------------- | ------ | -------------------- |
| `gh-proxy.org`       | —      | 无 IPv6 时的默认镜像 |
| `v6.gh-proxy.org`    | `v6`   | 有 IPv6 时的默认镜像 |
| `v4.gh-proxy.org`    | `v4`   | 强制 IPv4            |
| `cdn.gh-proxy.org`   | `cdn`  | CDN 节点             |
| `axisnow.gh-proxy.org` | `axisnow` |                  |

## 订阅自动更新

- 默认更新间隔：12 小时（订阅服务端可通过 `profile-update-interval` 覆盖）
- 触发时机：`start` 命令（`sub` 列表为纯只读，不再触发更新）
- **服务常驻期间不会自动更新**：launchd 只负责拉起内核，不会跑 `start`。`status` 会在订阅超过更新间隔时黄标提醒（`已超过 N 小时间隔，建议 mihomo sub update`），此时手动跑 `mihomo sub update` 或 `mihomo start` 即可
- 更新失败时继续使用本地缓存，不影响使用
- 自动更新默认超时 10 秒，可通过 `-u <ms>` 调整；使用 `-s` 可完全跳过自动更新

## 选项写法

带值选项支持三种等价写法，长短选项对应关系：

| 短 | 长 | 用途 | 默认 |
| --- | --- | --- | --- |
| `-u` | `--update-timeout` | 启动时自动更新订阅超时（ms） | 10000 |
| `-n` | `--lines` | 日志显示行数 | 100 |

```bash
mihomo start -u 30000            # 短选项 + 空格
mihomo start --update-timeout 30000   # 长选项 + 空格
mihomo start --update-timeout=30000   # 长选项 + 等号
```

布尔开关：`-s`（跳过订阅更新）、`--no-update`、`-y`/`--yes`（跳过确认）、`-o`（用系统默认程序打开）。

上述数值选项只接受 **>= 1 的整数**，非法值（`0`、负数、`5s`、`abc`）会直接报错而非静默取默认值——避免静默产出看似成功的错误结果。

## 数据保护

- **订阅内容校验**：下载到的内容必须含 `proxies` / `proxy-groups` / `proxy-providers` 之一才写盘。机场返回配额或错误 JSON（如 `{"error":"quota exceeded"}`）时报错并**保留磁盘上原有的可用配置**，不会被覆盖
- **`sub add` 失败回滚**：下载失败时移除半成品订阅，且不改动当前活跃订阅
- **`settings.json` 损坏恢复**：格式损坏（含合法 JSON 但非对象的情况）时自动备份为 `.bak` 并回退默认设置
- **`reset` 停止确认**：需要停止进程的重置会先确认进程真的已终止，未能停止时中止重置而非留下孤儿进程跑在已删配置上

## 数据目录

用户数据存储位置（与安装位置分离，更新不丢失）：

```
~/.mihomo-cli/
├── settings.json         # 用户设置（订阅列表、当前订阅、覆写开关、端口覆盖等）
├── service.lock          # 服务启停的跨进程锁（刻意放在根下：runtime/ 会被 stop 整体清除）
├── overwrite.yaml        # 覆写配置（主文件，可选）
├── overwrite.*.yaml      # 覆写配置（扩展文件，如 overwrite.dns.yaml）
├── subscriptions/
│   ├── cache.json        # 订阅动态缓存（更新时间、流量、到期时间等）
│   └── <name>.yaml       # 订阅原始配置
├── kernel/
│   └── mihomo            # mihomo 内核二进制
├── logs/
│   ├── mihomo.log        # 当前日志
│   └── mihomo.YYYY-MM-DD_HH-MM-SS.log  # 归档日志
├── data/                 # mihomo 运行数据（GeoIP 等，由内核自行管理）
└── runtime/              # 运行时临时文件（stop 自动清除）
    ├── pid               # 进程 PID
    ├── config.yaml       # 运行时生成的配置
    ├── 1.subscription.yaml   # 分阶段调试：订阅原始配置
    ├── 2.overwrite.yaml      # 分阶段调试：应用覆写后
    └── 3.system.yaml         # 分阶段调试：合并系统配置后
```

可通过环境变量 `MIHOMO_CLI_DIR` 自定义数据目录位置。

## 覆写配置

覆写配置允许你在订阅配置基础上进行自定义修改，而不会影响订阅本身。

### 使用方法

1. 在 `~/.mihomo-cli/` 目录下创建覆写文件：
   - `overwrite.yaml` — 主覆写文件
   - `overwrite.dns.yaml` — 按功能拆分的扩展文件（`overwrite.*.yaml` 格式）
2. `overwrite.yaml` 始终最先加载，扩展文件按文件名排序加载
3. 覆写**默认即启用**，放好文件后重启生效（`mihomo start`）；如曾 `ow off` 禁用过，用 `mihomo ow on` 重新启用（会自动重启）

### 特殊语法

覆写配置支持以下特殊操作符：

| 语法     | 作用                                      | 示例                 |
| -------- | ----------------------------------------- | -------------------- |
| `key!`   | 强制覆盖整个对象（不深度合并）            | `dns!`: { ... }      |
| `+key`   | 数组前置插入                              | `+proxies`: [...]    |
| `key+`   | 数组追加                                  | `rules+`: [...]      |
| `~key`   | 按 `name` 就地合并数组中的单个元素        | `~proxy-groups`: [...] |
| `<+key>` | 键名以 `+`/`~` 等符号开头时转义           | `<+.google.cn>`: ... |

`~key` 用于**只修改数组里某一个元素的部分字段**，而不动其余元素、也不必复制整个元素。以 `name` 为主键匹配：命中同名元素则深度合并该元素，找不到则追加。典型用途：修改订阅下发的某个 `proxy-group` 的字段（如默认选中的节点），订阅更新后依然生效。

> `~key` / `+key` / `key+` 都是**数组语义**：若目标键已存在且不是数组（如 `~dns` 作用于映射、`log-level+` 作用于字符串），会直接报错而非静默包成单元素数组——后者会丢掉原有字段并生成 mihomo 无法解析的配置。要覆盖非数组值请用 `key!`（强制覆盖）或直接写 `key`（深度合并）。

### 作用域限定（match）

在覆写文件顶部加 `match:` 块，可让该文件**只对指定订阅生效**（无 `match` 则全局生效）。所列条件需全部满足（AND），条件值为数组时其内部为 OR：

| 匹配键        | 作用                          |
| ------------- | ----------------------------- |
| `subscription` | 按订阅名匹配（大小写不敏感，与 `sub use` 口径一致） |
| `url-domain`   | 按订阅 URL 的 hostname 后缀匹配（大小写不敏感） |

`match` 块**写错会直接报错**（键名拼错、值为空、空块），而不是静默忽略后对所有订阅生效——写了 `match` 显然是想限定作用域，悄悄放宽比报错危险得多。

### 示例

```yaml
# ~/.mihomo-cli/overwrite.yaml

# 强制覆盖 dns 配置
dns!:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 223.5.5.5

# 追加规则
rules+:
  - 'DOMAIN-SUFFIX,example.com,DIRECT'
```

```yaml
# ~/.mihomo-cli/overwrite.edu1.yaml
# 只对 edu1 订阅生效：把订阅下发的 Developer 分组默认选中改为 TW Fixed IP
match:
  subscription: edu1          # 或 url-domain: glados-config.com

~proxy-groups:
  - name: Developer
    default-selected: TW Fixed IP
```

> 注：`default-selected` 由 mihomo 内核决定默认选中项，优先级低于 `store-selected` 缓存的历史选择。若之前手动选过、且开启了 `store-selected`，需 `mihomo reset data` 清缓存后才能看到默认值接管。

### 同时使用多个机场

本 CLI 是单活跃订阅模型（`sub use` 切换），不合并多条订阅。要把第二个机场的节点并进当前订阅，用覆写引入 mihomo 原生的 `proxy-providers`——节点池由内核按 `interval` 自动刷新，不受单订阅模型限制：

```yaml
# ~/.mihomo-cli/overwrite.providers.yaml
proxy-providers:
  second-airport:
    type: http
    url: https://second-airport.example.com/api/v1/client/subscribe?token=xxx
    interval: 86400              # 节点池自动刷新间隔（秒）
    path: ./second-airport.yaml  # 缓存文件（mihomo 管理，相对运行时配置目录）
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

# 新增一个走第二机场的分组（+ 是数组前置插入，订阅分组不动）
+proxy-groups:
  - name: SecondAirport
    type: select
    use: [second-airport]

# 需要分流到它时加规则
rules+:
  - 'DOMAIN-SUFFIX,corp.example.com,SecondAirport'
```

provider 节点与订阅节点同池参与分组选择；节点延迟与手动切换在 Web UI（`mihomo ui`）里操作。若想让订阅里已有的某个分组也纳入第二机场的节点，用 `~proxy-groups` 按 name 就地 patch 该分组、加 `use` 字段

### 用 ssh -D 做节点

v4.0 之前的 ssh 隧道功能已移除（维护面大于价值）。等效做法：自己起一条 `ssh -D 127.0.0.1:1080 -N host`，再把它作为 socks5 节点写进覆写：

```yaml
# ~/.mihomo-cli/overwrite.ssh.yaml
~proxies:
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
mihomo doctor
```

逐项检查内核可执行性、数据目录可写、settings 有效性（含端口覆盖合法性）、订阅配置与新鲜度、服务状态、端口占用、
配置可构建性、代理连通性、CLI 版本（落后时提示 `mihomo update`；npm registry 不可达则跳过），
每项给出 ✓/!/✗ 与修复命令；存在异常项时退出码为 1，可接入脚本。

### 启动失败

`mihomo start` 会确认内核真的跑起来了才报「已启动」——内核因配置问题启动后立即退出时，命令会报错并直接附上日志尾部，退出码非 0。常见原因是端口被占用或订阅里有内核不接受的字段。报错会写明死因，与下面 `status` 的提示同口径（`退出码 N` 或 `被信号终止（Killed: 9）`）。

```bash
mihomo logs 0        # 看完整原因
mihomo stop          # 止住 launchd 的反复重试
```

若 `status` 显示「不在运行」但带「内核上次异常退出」的提示，说明内核正在崩溃循环中被反复拉起，同样按上面两步处理。提示会区分两种死法：`退出码 N`（内核自己退的，多为配置问题）与 `被信号终止（Killed: 9）`（被外部杀掉，常见于系统内存不足时被 OOM killer 干掉）。

### 进程无法停止

```bash
sudo pkill -9 mihomo
```

### TUN 模式无法启动

1. 确保使用 sudo / 管理员权限
2. 检查是否有其他程序占用 53 端口
3. 查看日志：`mihomo logs 0 -f`

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

改动后 `mihomo start` 重新生成配置即生效；Web UI 连接地址与系统代理里的端口请使用新值（`mihomo status` 会显示实际端口）

## 安全特性

- **URL 脱敏**：订阅 URL 中的 token、key、password 等敏感参数（含 query、userinfo 及路径型令牌）自动替换为 `***`。按整条 URL 处理、不按逗号切分——逗号在 query 中合法，切开会让 `?nodes=us,hk&token=xxx` 的 token 参数识别不出而明文输出
- **文件权限**：配置文件使用 `0o600` 权限（仅所有者可读可写），目录使用 `0o700` 权限
- **入站默认关闭**：订阅/覆写未指定时 `allow-lan` 默认 `false`；如需局域网设备连入代理端口，可在订阅或覆写中显式开启
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
