# mihomo-cli

一个基于命令行的 mihomo（Clash.Meta）客户端，**仅支持 macOS**

服务托管依赖 launchd、目录和网页打开依赖 `open`、TUN 提权依赖 `sudo`，均没有其他平台实现。Windows / Linux 适配尚无时间表

## 文档导航

- [安装](#安装) · [快速开始](#快速开始) · [命令参考](#命令参考) · [状态与生效](#状态与生效)
- [模式说明](#模式说明) · [服务托管](#服务托管) · [内核更新通道](#内核更新通道) · [订阅自动更新](#订阅自动更新)
- [数据保护](#数据保护) · [数据目录](#数据目录) · [覆写配置](#覆写配置) · [Web UI](#web-ui)
- [故障排除](#故障排除) · [安全特性](#安全特性)

## 功能特性

- **双运行模式**：Mixed 提供 HTTP + SOCKS5 混合端口；TUN 接管系统流量并按 mihomo 规则分流
- **服务托管**：Mixed 由用户级 LaunchAgent 管理，支持异常退出拉起和登录自启；正常启停免密
- **订阅管理**：添加、切换、更新和删除订阅；机场提供相应响应头时显示流量、到期时间与更新新鲜度
- **覆写配置**：YAML 声明式合并与 JS 同步脚本，支持按订阅限定作用域及单文件启停
- **配置预览**：`config` 重新推导候选配置，停止时也可用；常见凭据默认脱敏
- **状态与诊断**：查看进程、端口、订阅和覆写状态，独立探测代理连通性；`doctor` 汇总检查与修复指引
- **日志管理**：查看、跟随和归档内核日志，启动或重启时清理过期归档
- **在线 Web UI**：打开 zash、metacubexd 或 YACD 页面，连接本机控制器
- **内核更新**：按需检查并下载稳定版，支持本机代理、GitHub CLI、直连和显式镜像
- **可配置端口**：默认 Mixed 端口 7890、控制器端口 9090，可在 `settings.json` 中覆盖

`mihomo-cli` 与 `mh` 等价；命令和子命令拼错时会给出相近命令建议

## 安装

**前置要求：Node.js >= 24.20.0**。入口有版本守卫，低版本会直接报错并给出升级指引

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

全新环境直接运行 `mihomo-cli`（不带参数）会显示状态与「开始使用」引导，缺哪步列哪步

### 1. 下载内核

```bash
mihomo-cli kernel
```

下载通道按当前环境选择；国内网络、纯 IPv6 或已有其他代理工具时，见[内核更新通道](#内核更新通道)

### 2. 添加订阅

```bash
mihomo-cli sub add "https://your-subscription-url" "my-proxy"

# 或先复制订阅链接，再运行；交互下读取剪贴板并在确认后添加
mihomo-cli sub add
```

添加成功后会切换到新订阅。CLI 不会自动通过本机 Mixed 端口或 macOS 系统代理下载订阅，网络限制见[订阅下载的网络边界](#订阅下载的网络边界)

### 3. 安装并启动 Mixed 服务

```bash
mihomo-cli install       # 只需安装一次，装完不启动
mihomo-cli start         # 启动并开启登录自启
```

再次执行 `mihomo-cli start` 会应用新配置：优先热重载，不可用时重启内核

```bash
mihomo-cli stop          # 停止并关闭登录自启
mihomo-cli tun           # 或按需启动临时 TUN，需管理员权限
```

### 4. 在具体应用中按需配置代理

**CLI 不会自动修改 macOS 系统代理，也不提供全局 `proxy on/off`。无需为了使用本工具去设置全局 Mac 代理**

在需要代理且支持自定义代理的浏览器或其他应用中，按应用支持的协议选择一种：

| 协议 | 地址 | 默认端口 |
| --- | --- | --- |
| HTTP 代理 | `127.0.0.1` | `7890` |
| SOCKS5 代理 | `127.0.0.1` | `7890` |

只给确有需要的应用配置。改过 `ports.mixed` 时以 `mihomo-cli status` 显示的实际端口为准

### 5. 可选：打开在线 Web UI

```bash
mihomo-cli ui          # 默认 zash
mihomo-cli ui dash     # metacubexd
mihomo-cli ui yacd     # YACD
```

这些面板是在线网页，不随 CLI 内置，也不是使用代理的前提。其连接与信任边界见 [Web UI](#web-ui)

## 命令参考

### 核心命令

| 命令 | 说明 |
| --- | --- |
| `mihomo-cli install` | 安装 Mixed 服务；重装时保持原运行状态 |
| `mihomo-cli start [tun\|mixed]` | 启动并应用配置；Mixed 同时开启登录自启，`-s` 跳过订阅更新，`-u` 调整更新超时 |
| `mihomo-cli stop` | 停止代理并关闭登录自启 |
| `mihomo-cli uninstall` | 卸载服务，保留其他数据 |
| `mihomo-cli status` | 查看运行状态、端口、订阅与覆写状态；`[-j\|--json]` 机器可读，`--no-probe` 跳过连通性探测 |
| `mihomo-cli logs` | 列出当前日志与历史归档 |
| `mihomo-cli logs <编号>` | 查看日志：`0` 为当前，`1+` 为归档；`-f` 跟随，`-n N` 行数，`-o` 用系统程序打开 |
| `mihomo-cli logs -f` | 跟随当前日志；给 `-f` / `-n` / `-o` 而省略编号时均视为 `logs 0` |

### 订阅管理

| 命令 | 说明 |
| --- | --- |
| `mihomo-cli sub` | 列出订阅及可用的流量、到期和更新信息 |
| `mihomo-cli sub add [url] [name]` | 添加并切换订阅；不带 URL 时交互读取剪贴板，名称省略则为 `default` |
| `mihomo-cli sub use <name>` | 切换当前订阅；运行中自动应用，停止时只修改设置 |
| `mihomo-cli sub update` | 更新所有订阅 |
| `mihomo-cli sub update <name>` | 更新指定订阅 |
| `mihomo-cli sub remove <name>` | 删除订阅，别名 `rm` / `delete`；精确名直接删除，匹配名需确认，`-y` 跳过确认 |

订阅名允许字母、数字、下划线、短横线和中文，最长 64 字符，忽略大小写后不可重复。`use` / `update` / `remove` 的名称匹配不区分大小写，依次尝试精确、前缀、包含匹配；同一档有多个结果时会列出候选并要求更精确指定，不会任意选一个

本 CLI 是**单活跃订阅**模型，不把多条订阅合并成一份配置。需要同时使用多个机场时，用 mihomo 原生 `proxy-providers`，见[同时使用多个机场](docs/overwrite.md#同时使用多个机场)

节点测速请使用 Web UI，或在订阅中配置 `url-test` 分组由内核自动选路

### 覆写与配置

| 命令 | 说明 |
| --- | --- |
| `mihomo-cli ow` | 查看覆写总开关、文件列表和加载错误 |
| `mihomo-cli ow on` | 启用全部覆写，默认即启用；运行中自动应用 |
| `mihomo-cli ow off` | 全局停用覆写；运行中自动应用 |
| `mihomo-cli config [-j\|--json] [--reveal]` | 预览按当前订阅缓存、覆写和设置推导的候选配置；停止时也可用 |

`ow on/off` 是全局总开关。只停用某一个 YAML 文件时，在该文件中写 `enabled: false`；单个 JS 脚本通过改扩展名停用，见[覆写配置](#覆写配置)

`config` 不写盘、不重启，也不执行内核原生校验；校验由 `start` / `doctor` 完成。默认脱敏只是降低展示泄漏概率，`--reveal` 会明文输出节点密码、UUID、私钥、控制器密钥及 provider URL，不要在录屏、管道或求助文本中未经检查使用

### 其他命令

| 命令 | 说明 |
| --- | --- |
| `mihomo-cli kernel [--mirror [镜像]] [--proxy <端口\|地址>]` | 检查并更新内核；详细候选规则见[内核更新通道](#内核更新通道) |
| `mihomo-cli update` | 更新 mihomo-cli；已是最新版则跳过重装 |
| `mihomo-cli ui [zash\|dash\|yacd] [-c]` | 打开在线 Web UI；`-c` 把控制器访问密钥复制到剪贴板，默认不动剪贴板 |
| `mihomo-cli dir` | 显示数据目录位置 |
| `mihomo-cli dir open [target]` | 打开目录：`root`、`subs`、`logs`、`data`、`runtime`、`kernel` |
| `mihomo-cli reset [目标...] [--full] [-y]` | 重置受管数据；目标为 `subs`、`logs`、`data`、`runtime`、`settings`、`kernel`、`overwrites`、`service` |
| `mihomo-cli doctor` | 检查内核、服务、端口、订阅、配置、连通性及版本；有异常项时退出码为 1 |
| `mihomo-cli version` | 显示版本信息 |
| `mihomo-cli help [命令]` | 显示帮助；也可用 `mihomo-cli <命令> -h` |

### 命令别名与快捷命令

`mihomo-cli` 与 `mh` 等价。子命令组别名为：

- `subscription` = `sub` / `subs` / `subscriptions`
- `directory` = `dir` / `dirs` / `directories`
- `overwrite` = `ow`

| 快捷命令 | 等效于 |
| --- | --- |
| `mihomo-cli tun` | `mihomo-cli start tun` |
| `mihomo-cli use <name>` | `mihomo-cli subscription use <name>` |
| `mihomo-cli restart` | `mihomo-cli start` |

## 状态与生效

「文件已经更新」「配置已经生成」「运行中的内核已经应用」是三个不同状态：

| 操作 | 改变了什么 | 运行中的实例何时使用新结果 |
| --- | --- | --- |
| `config` | 只在终端展示按当前缓存和设置推导的预览 | 不改变运行实例，也不保证内核会接受该配置 |
| `start` / `restart` | 按需更新过期订阅，构建并校验配置，写入 `runtime/config.yaml` | 优先热重载；不可用时重启，TUN 则重建临时进程 |
| `sub use` / `ow on` / `ow off` | 修改当前订阅或覆写总开关 | 仅在已有实例运行时自动走 `start` 流程；停止时不启动 |
| `sub add` / `sub update` | 更新订阅条目、缓存或原始配置 | 不自动应用；按命令提示执行 `start`，TUN 中用 `start tun` |
| `sub remove` | 删除订阅条目、原始配置和缓存；删当前项时更新活跃设置 | 运行实例可能仍用已删除订阅的旧配置；按提示重启 |
| `kernel` | 校验后替换磁盘上的内核二进制 | 已运行进程仍是旧版本；先执行 `stop`，再执行 `start` 或 `start tun` 才会加载新二进制 |

`status` 的覆写清单和 `status --json` 的 `overwrite.applied` 只表示文件被选中，不证明 JS 脚本适用于当前订阅或实际修改了配置；选中规则与执行边界见 [覆写配置详版](docs/overwrite.md)

## 模式说明

### Mixed 模式（默认）

- 在回环地址提供 HTTP + SOCKS5 混合端口，默认 `127.0.0.1:7890`
- 由 launchd 托管，需先执行一次 `mihomo-cli install`
- 需要代理的浏览器或应用自行配置 Mixed 地址；CLI 不自动设置 macOS 系统代理
- 正常安装和启停免密；清理 root 属主的 TUN 残留时仍可能要求管理员密码

### TUN 模式（透明代理）

- 接管系统流量并交给 mihomo 按规则分流，不等于所有连接都一定走代理节点
- 每次启动生成 TUN 路由与 DNS 配置；`dns.enable` 强制为 `true`
- 以按需 `sudo` 的临时进程运行，不走 launchd；关闭终端不会停止，使用 `mihomo-cli stop` 收掉
- 与运行中的 Mixed 服务互斥，需先 `mihomo-cli stop`

## 服务托管

Mixed 由 macOS 原生 **launchd** 托管。执行过 `start` 且未再 `stop` / `uninstall` 时，内核异常退出会被拉起，重新登录后也会自动启动

```bash
mihomo-cli install         # 安装服务，不启动
mihomo-cli start           # 启动或应用配置，并开启登录自启
mihomo-cli stop            # 停止并关闭登录自启
mihomo-cli uninstall       # 停止并卸载服务
mihomo-cli status          # 查看服务、运行和自启状态
```

服务是当前用户的 LaunchAgent，位于 `~/Library/LaunchAgents/`、`gui/<uid>` 域，正常服务操作不需要 root。除 mihomo 内核本身外，没有额外的 CLI 守护或轮询进程

### 命令语义

| 命令 | 当前操作 | 重新登录后 |
| --- | --- | --- |
| `install` | 写入 plist，首次安装不启动 | 不启动 |
| `start` | 启动；已运行时优先热重载，失败再重启，并开启自启 | 自动启动 |
| `stop` | 停止并关闭自启 | 不启动 |
| `uninstall` | 停止、关闭自启并删除 plist | 不启动 |

`stop` 与只杀进程的区别在于同时关闭自启，避免下次登录时服务重新出现。配置变更优先通过控制器热重载，通常无需重启进程；热重载不可用时会回退到重启，不在文档层承诺任何配置变更都绝不影响既有连接

`start` 会确认内核进入运行状态后才报告成功。坏配置、端口占用或权限问题会报错并附日志位置或日志尾部，而不是只凭 `bootstrap` 返回成功就宣称可用

### 卸载与彻底移除

`uninstall` 只卸服务，订阅、内核、日志等仍保留。完整移除应按顺序执行：

```bash
mihomo-cli reset --full   # 删除所有已登记的受管数据并卸载服务
npm uninstall -g mihomo-cli
```

`reset --full` 不保证清空整个数据目录：锁、停止计数、无法识别的近失文件和用户手工放入的其他文件可能保留。若还要删除这些残留与目录本身，默认安装下可在确认路径和内容后执行：

```bash
rm -rf ~/.mihomo-cli
```

不要先卸载 npm 包，否则清理 LaunchAgent 的命令也不可用。npm 现代版本不会执行 uninstall 生命周期钩子，不能依赖卸载钩子提醒或清理

如果已经先卸载了 npm 包，先手动执行：

```bash
launchctl bootout gui/$(id -u)/com.mihomo-cli.daemon
```

命令成功或明确提示服务未装载时再继续；其他错误应先解决，不要直接删除 plist：

```bash
rm -f ~/Library/LaunchAgents/com.mihomo-cli.daemon.plist
rm -rf ~/.mihomo-cli
```

「系统设置 → 通用 → 登录项与扩展」中的条目显示为 `mihomo-cli-service`

### macOS 本地网络授权

服务以当前用户身份运行。macOS 15+ 对用户进程访问局域网其他设备有隐私限制，首次连接时可能出现「允许访问本地网络」提示，条目可在「系统设置 → 隐私与安全性 → 本地网络」中查看

`127.0.0.1` / `::1` 属于 loopback，不受此限制；自行运行 `ssh -D 127.0.0.1:1080` 并把节点指向它也不受此限制。节点直接指向 `192.168.x.x`、`10.x.x.x`、`*.local` 等局域网地址时才可能涉及授权

内核更新后，macOS 可能按新的可执行文件重新要求授权。若局域网节点持续无法连接，请记录 macOS 版本、节点地址类型、授权条目和 `doctor` 输出后提 issue；不要按未经验证的教程删除系统网络扩展或隐私数据库

### TUN 与服务切换

TUN 与服务会争用端口和同一份运行配置，服务运行时执行 `mihomo-cli tun` 会被拦下：

```bash
mihomo-cli stop      # 先停 Mixed 服务
mihomo-cli tun       # 启动临时 TUN，按需输入管理员密码
mihomo-cli stop      # 收掉 TUN
mihomo-cli start     # 重建 Mixed 配置并恢复服务与自启
```

`mihomo-cli tun` 会自动关闭服务的登录自启并提示，避免下次登录时普通用户服务拿 TUN 配置反复启动失败。TUN 启动失败时也会给出恢复 Mixed 的命令

TUN 会劫持 53 端口流量，因此 `dns.enable` 恒为 `true`；订阅或覆写显式关闭时会被改回并提示。`nameserver`、`enhanced-mode` 等仍按用户配置处理，Mixed 不受此限制

### 不要用 sudo 运行整个 CLI

`sudo mihomo-cli …` 会被拒绝。服务属于当前用户的 `gui/<uid>` 域，TUN 所需权限由 CLI 内部按需申请，无需也不能在外层加 `sudo`

### 日志

运行日志持续追加到 `mihomo.log`。轮转和清理不是后台定时任务：

- 冷启动时，非空当前日志会归档为 `mihomo.<时间戳>.log`
- 运行中的配置热重载通常不轮转日志
- 当前日志超过 10 MB 后，下一次进程重启会顺便轮转；长期不启动或重启时它仍可能继续增长
- 启动或重启时会清理 7 天前的归档；同秒多次轮转使用序号后缀避免覆盖

```bash
mihomo-cli logs         # 列出当前日志与归档
mihomo-cli logs 0 -f    # 实时跟随当前日志
mihomo-cli logs 1       # 查看最新归档
```

## 内核更新通道

`mihomo-cli kernel` 每次按当前环境重新选择，不持久化通道或镜像偏好。自动下载候选如下，失败时只尝试列表中的下一项，不会额外补一条直连候选：

| 当前环境 | 下载候选顺序 |
| --- | --- |
| 本机 mihomo 代理正在运行 | curl 经本机 Mixed 端口；若装有 `gh`，再尝试仍经同一代理的 `gh release download` |
| 本机代理未运行，装有 `gh` | 仅 `gh release download` |
| 本机代理未运行，且没有 `gh` | 仅 curl 直连 |

因此「本机代理 > gh > 直连」是环境选择的大致顺序，不是任何失败后都会走完的三级回退链。代理在跑时的回退只换客户端、不换出网路径或机场节点；两条通道都低速失败时，应在面板中切换主分组线路后重试，或显式选择其他通道

显式选项只产生一个下载候选，不自动换道：

```bash
mihomo-cli kernel                # 按上表自动选择
mihomo-cli kernel --mirror       # 仅走 gh-proxy.org 镜像
mihomo-cli kernel --mirror v6    # 仅走 v6.gh-proxy.org，适合显式选择 IPv6 镜像
mihomo-cli kernel --mirror cdn   # 短别名：cdn / v4 / v6 / axisnow
mihomo-cli kernel --mirror hk.gh-proxy.org  # 指定镜像主机名或完整 URL
mihomo-cli kernel --mirror direct  # 仅直连，下载和版本查询都绕过代理
mihomo-cli kernel --proxy 7897   # 仅经 127.0.0.1:7897 下载与查询版本
mihomo-cli kernel --proxy socks5://127.0.0.1:7897  # 完整代理地址
```

`--mirror` 与 `--proxy` 可组合：镜像决定下载地址，代理只负责传输；`--mirror direct` 与 `--proxy` 互斥

镜像不会自动启用，也不持久化。可用镜像与别名：

| 镜像 | 短别名 | 说明 |
| --- | --- | --- |
| `gh-proxy.org` | — | 裸 `--mirror` 的默认主机 |
| `v6.gh-proxy.org` | `v6` | 显式选择 IPv6 镜像 |
| `v4.gh-proxy.org` | `v4` | 显式选择 IPv4 镜像 |
| `cdn.gh-proxy.org` | `cdn` | CDN 节点 |
| `axisnow.gh-proxy.org` | `axisnow` | 备用镜像 |

### 版本查询与来源约束

GitHub API 绝不经过镜像。版本查询按以下方式出网：

- 显式 `--proxy` 或本机代理可用时，curl 经该代理查询
- 无代理且 `gh` 可用时，先走 `gh api` 认证通道；失败后回退 curl 直连
- `--mirror direct` 时，curl 直接连接 GitHub，不读 env 代理
- `doctor` 没有 `--proxy` 选项，按本机代理和 `gh` 可用性选择查询方式

下载地址在添加镜像前缀之前校验，必须来自 GitHub 官方地址。第三方镜像只作为传输层，但不能证明产物与上游完全相同；完整性保证与信任边界见 [SECURITY.md](SECURITY.md#内核二进制来自上游-github-release)。优先使用 gh 或 curl 的 GitHub HTTPS 通道

内核更新不是后台自动任务。运行中的进程在替换二进制后仍使用旧版本，需按[状态与生效](#状态与生效)先停止再启动；单独执行 `start` 可能只热重载配置

## 订阅自动更新

- 默认更新间隔为 12 小时，订阅服务端可通过 `profile-update-interval` 覆盖
- 执行 `mihomo-cli start` 时检查并更新过期订阅；`sub use` / `ow on|off` 触发的运行中重启也走这一流程
- 常驻服务本身不会定时更新，重新登录由 launchd 拉起内核也不等于执行了 `start`
- `status` 会对超过更新间隔的订阅给出黄标；手动 `sub update` 可刷新缓存，运行中还需按提示重启才能应用
- 自动更新失败时会尝试继续使用已有本地配置，但这不保证节点仍有效或代理一定可用
- 自动更新默认整体超时 10 秒，可用 `-u <ms>` 调整，`-s` 完全跳过

`sub` 列表只读，不触发自动更新

### 订阅下载的网络边界

订阅使用 Node HTTP 客户端下载，CLI 不会自动经本机 Mixed 端口或 macOS 系统代理转发，`kernel --proxy` 也不作用于订阅。订阅地址在只能代理出网的网络中可能无法添加或更新

首次添加需要在能访问订阅地址的网络下完成，或换用可直连的订阅地址；已有可用 TUN 路由时，订阅下载会随系统路由转发。不要把「内核下载支持 `--proxy`」理解为订阅也有同名选项

## 选项写法

带值选项支持三种等价写法：

| 短选项 | 长选项 | 用途 | 默认 |
| --- | --- | --- | --- |
| `-u` | `--update-timeout` | `start` 自动更新订阅的整体超时（ms） | `10000` |
| `-n` | `--lines` | 日志显示行数 | `100` |
| `-p` | `--proxy` | 内核下载与版本查询使用指定代理 | — |

```bash
mihomo-cli start -u 30000
mihomo-cli start --update-timeout 30000
mihomo-cli start --update-timeout=30000
```

上述数值选项只接受 >= 1 的整数，`0`、负数、`5s`、`abc` 会直接报错，不会静默取默认值

常用布尔选项包括 `-s` / `--no-update`（跳过订阅更新）、`-y` / `--yes`（跳过确认）、`-o`（用系统默认程序打开）。各命令只接受自己实际消费的选项，完整集合以对应帮助为准

## 数据保护

- **订阅内容校验**：下载内容必须含非空的 `proxies`、`proxy-groups` 或 `proxy-providers` 来源之一才写盘。机场返回错误或配额 JSON 时会报错，校验发生在覆盖原有配置之前
- **订阅更新失败回滚**：新配置写入后若订阅缓存写入失败，已有订阅恢复更新前内容，新增订阅删除本次半成品；回滚本身失败时会明确提示当前内容未确认
- **`sub add` 失败回滚**：下载失败时移除本次新增的半成品订阅，不主动切换原活跃订阅
- **损坏设置备份**：`settings.json` 解析失败或不是对象时，读取回退默认设置，并把原件备份为 `settings.json.bak`；只保留首份备份。备份用于手工修复，不会自动还原，后续设置写入可能重新生成 `settings.json`
- **配置图资源保护**：循环引用与超过 200 层的嵌套在解析/合并时直接报错；`config` 的脱敏副本或 JSON 输出展开超过 100000 个节点时拒绝展示，该展示预算不限制订阅下载与 `start`
- **启动前内核校验**：`start` 和 `doctor` 使用已安装内核执行 `-t`。启动校验失败时保留现有 `runtime/config.yaml`，不会自动删除节点、分组或规则；`config` 只做预览，不做这项校验
- **破坏性操作确认**：`sub remove` 使用完整名称精确匹配时视为明确意图，直接删除；模糊匹配及其他需要确认的操作，在非交互环境必须显式传 `-y`，否则报错且不执行删除
- **重置前停止确认**：需要停止进程的重置会先确认进程已终止，失败则中止删除

### reset 的默认范围

裸 `mihomo-cli reset` 删除订阅、日志、运行数据和运行时文件，会停止服务并关闭登录自启，但保留服务安装、内核、覆写文件、端口和密钥等其他设置

`reset --full` 删除全部已登记目标并卸载服务，不等于清空整个目录。指定多个目标时顺序不影响结果；`reset overwrites` 删除识别到的覆写文件并恢复默认启用状态，`reset settings` 同时删除 `settings.json` 与其 `.bak` 备份

重置配置类目标不代表运行中的内核会立即使用新状态，后续仍需按场景执行 `start`

## 数据目录

用户数据与安装位置分离，升级 npm 包不会主动清除：

```text
~/.mihomo-cli/
├── settings.json              # 订阅列表、当前订阅、覆写开关、端口和控制器密钥等
├── settings.json.bak          # 损坏设置的首份备份，存在时才有
├── settings.lock              # 设置读改写的跨进程锁
├── subscription-cache.lock    # 订阅缓存读改写的跨进程锁
├── subscription-commit.lock   # 订阅 YAML、缓存提交与失败回滚的跨进程锁
├── service.lock               # 服务启停的跨进程锁
├── service-stop-epoch         # 并发启停的停止计数
├── overwrite.yaml             # YAML 主覆写，可选
├── overwrite.*.yaml           # YAML 扩展覆写，也认 .yml
├── overwrite.js               # JS 主脚本，可选，也认 .mjs / .cjs
├── overwrite.*.js             # JS 扩展脚本，也认 .mjs / .cjs，全部在 YAML 前执行
├── subscriptions/
│   ├── cache.json             # 更新时间、流量、到期时间等动态缓存
│   └── <name>.yaml            # 订阅原始配置
├── kernel/
│   └── mihomo                 # 内核二进制
├── logs/
│   ├── mihomo.log             # 当前日志
│   └── mihomo.YYYY-MM-DD_HH-MM-SS[.N].log
├── data/                      # GeoIP、选择缓存等，由内核管理
└── runtime/
    ├── pid                    # TUN 临时进程的 PID；Mixed 服务不使用此文件
    └── config.yaml            # 最近一次通过校验并写入的运行配置
```

可通过 `MIHOMO_CLI_DIR` 自定义数据目录。以下变量仅用于开发或隔离测试，日常不要设置：

| 变量 | 用途 |
| --- | --- |
| `MIHOMO_CLI_ALLOW_ANY_PLATFORM=1` | 绕过非 macOS 平台守卫，功能不保证可用 |
| `MIHOMO_CLI_DAEMON_LABEL` | 覆盖持久化服务 label；随意改名会遗留无法管理的自启进程 |

## 覆写配置

覆写在订阅配置基础上做自定义修改，原始订阅文件保持独立。支持 YAML 声明式合并和 JS 同步脚本，默认启用；修改文件后执行 `mihomo-cli start` 应用

- `mihomo-cli ow` 查看文件与加载状态，`ow on/off` 控制全局开关
- 单个 YAML 文件用 `enabled: false` 停用，单个 JS 脚本通过改扩展名停用
- 多机场节点使用 mihomo 原生 `proxy-providers`，SSH 出口由用户自行 `ssh -D`
- JS 脚本以当前用户身份全信任运行；`ow` / `status` 加载模块时也会执行顶层代码，不要安装来路不明的脚本

文件格式、加载顺序、YAML 操作符、JS 契约、match、多机场与 SSH 示例见 [覆写配置详版](docs/overwrite.md)

## Web UI

`mihomo-cli ui` 打开以下**在线页面**，需要联网；CLI 不下载或托管这些前端：

| 名称 | 地址 | 说明 |
| --- | --- | --- |
| zash | <https://board.zash.run.place> | 默认面板 |
| dash | <https://metacubex.github.io/metacubexd> | MetaCubeX 官方 UI |
| yacd | <https://yacd.metacubex.one> | YACD 面板 |

网页连接的是本机外部控制器，默认 `http://127.0.0.1:9090`。自定义端口或密钥时，`ui` 会打印实际连接信息；`ui -c` 可复制密钥到剪贴板，但剪贴板可能被其他应用读取或同步到其他设备

在线页面的前端代码也需要被信任：它能向本机控制器发指令。`controller_secret` 可限制其他本机网页的访问，但不能消除你主动使用某个在线 UI 时的来源信任。未运行时 `ui` 仍会打开页面并提示暂时无法连接

## 故障排除

### 一键体检

```bash
mihomo-cli doctor
```

检查内核可执行性、数据目录、设置、订阅与新鲜度、服务、端口、配置的原生校验、代理连通性及内核和 CLI 版本。每项给出 ✓ / ! / ✗ 与修复指引；异常项使退出码为 1，警告不影响退出码

两个版本检查都访问网络，GitHub 或 npm 不可达时跳过，不算异常。`doctor` 输出可能包含订阅名称、路径和错误详情，分享前仍需人工检查与脱敏

### 启动失败

`start` 先让内核检查候选配置，失败时保留现有运行配置。CLI 不自动修复重名节点或失效引用，需要修改订阅或覆写后重试

提示会附上本次参与构建的覆写文件与作用域，帮助判断错误元素来自哪里：

```text
配置错误: 内核拒绝加载配置

  ProxyGroup Developer: '' has unset fields: type

  本次参与构建的覆写文件:
    overwrite.glados.yaml (url-domain=glados-config.com)
    overwrite.seal.yaml (全局)
  若报错的元素来自覆写（YAML 追加或 JS 脚本注入），检查对应的覆写文件与脚本。

  请修正订阅或覆写；当前运行时配置未改动。
```

清单按总开关、文件开关和 `match` 选择；脚本列入只表示会被调用，不证明它实际修改了配置。没有文件参与时不显示这一段。若订阅与覆写都看似正常，也可能是内核过旧，可尝试 `mihomo-cli kernel`

校验通过后仍需确认进程运行，端口占用、权限等启动问题会报错并附日志信息：

```bash
mihomo-cli logs 0        # 查看日志
mihomo-cli stop          # 停止 launchd 的反复重试
```

`status` 的「内核上次异常退出」会区分非零退出码和信号终止；后者可能来自手动 `kill` 或系统内存压力

### 进程无法停止

`mihomo-cli stop` 无效时的最后手段：

```bash
sudo pkill -9 mihomo
```

这会杀掉本机所有名为 mihomo 的进程，包括手动启动的其他实例

### TUN 模式无法启动

1. 直接运行 `mihomo-cli tun`，按提示输入管理员密码，不要在命令前加 `sudo`
2. 检查是否有其他程序占用 53 端口
3. 查看日志：`mihomo-cli logs 0 -f`
4. 若曾关闭 Mixed 自启，恢复时运行 `mihomo-cli start`

### 订阅更新失败

- 确认当前网络能直接访问订阅 URL，并阅读[订阅下载的网络边界](#订阅下载的网络边界)
- 确认订阅未过期、流量未耗尽，机场没有返回错误内容
- 错误中的 URL 会按规则脱敏，但分享完整输出前仍需人工检查
- 更新成功不等于运行实例已应用，按提示执行 `start` 或 `start tun`

### 端口被占用

Mixed 端口和控制器由 CLI 统一管理，订阅与覆写不能修改，默认值是：

- Mixed（HTTP + SOCKS5）：`7890`
- 外部控制器：`127.0.0.1:9090`

需要避开冲突时，在 `settings.json` 顶层配置 `ports`。两个键均可选，必须为 1–65535 的整数且最终值不能相同：

```json
{
  "ports": { "mixed": 17890, "controller": 19090 }
}
```

修改后执行 `mihomo-cli start` 才会应用。Web UI 控制器地址以及你手动配置的具体应用代理都要使用新值，`status` 会显示实际端口

## 安全特性

- **展示脱敏**：URL 按已知敏感参数名、userinfo 和长值规则掩码，配置中的常见密码、UUID、私钥及 provider URL 也会处理。规则是启发式的，长路径段可能保留首尾字符，自定义短凭据可能无法识别；分享输出前仍需人工检查，`config --reveal` 则明确显示原文
- **文件权限**：CLI 写入的配置文件使用 `0o600`，新建数据目录使用 `0o700`；已有自定义目录的权限不会被强制修改
- **入站只监听回环**：`allow-lan` 恒为 `false`，订阅与覆写都不能把 Mixed 端口暴露到局域网。确需局域网入站时，应在本机另起一个独立 mihomo 实例并自行评估其安全配置
- **入站与控制面由 CLI 管理**：订阅与覆写中的监听地址、独立入站服务、通用入站声明、局域网暴露与入站鉴权、外部控制器及证书段都会被剥除。端口与控制器密钥只认 `settings.json`，完整执行集以 `src/constants.ts` 的 `EFFECTIVELY_LOCKED_KEYS` 为准；覆写引用锁定键会提示，订阅侧静默剥除
- **原始凭据明文落盘**：订阅 URL 和配置依靠文件权限保护，不做加密，见 [SECURITY.md](SECURITY.md)

### 外部控制器与访问密钥

外部控制器默认监听 `127.0.0.1:9090` 且无鉴权。局域网不可达，但本机其他进程和浏览器网页可能访问它，不可信的多用户环境不应使用默认空密钥

在现有 `settings.json` 顶层合并 `controller_secret`，例如：

```json
{
  "controller_secret": "replace-with-a-long-random-secret"
}
```

执行 `mihomo-cli start` 后生效，`ui` 会提示连接时需要密钥。密钥由 CLI 锁定，订阅与覆写无法伪造；使用 `ui -c` 复制时注意剪贴板暴露。在线 UI 的信任边界见 [Web UI](#web-ui)

## 许可证

MIT License，详见 [LICENSE](LICENSE)

## 相关项目

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)：mihomo 内核
- [MetaCubeX/metacubexd](https://github.com/MetaCubeX/metacubexd)：Web UI
- [MetaCubeX/Yacd-meta](https://github.com/MetaCubeX/Yacd-meta)：YACD Web UI

## 免责声明

本工具仅供学习和研究使用。使用本工具时请遵守当地法律法规
