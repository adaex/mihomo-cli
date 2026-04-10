# mihomo-cli

一个基于命令行的 mihomo (Clash.Meta) 客户端，专为 macOS 设计。Windows / Linux 正在适配中，敬请期待。

## 功能特性

- 🌐 **订阅管理** - 添加/更新订阅，支持流量统计和到期时间显示
- 🔄 **自动更新** - 启动时自动检查并更新过期订阅
- 🔍 **模糊匹配** - `sub use` / `sub web` 支持订阅名称模糊匹配
- 📝 **覆写配置** - 在订阅基础上进行自定义覆写，支持强制覆盖、数组合并
- 🔄 **智能重启** - `sub use` 切换订阅、`ow on/off` 切换覆写后自动重启
- 🚀 **进程管理** - 启动/停止/切换模式，自动清理残留进程
- 🔄 **双模式支持** - Mixed 模式和 TUN 透明代理模式
- 📊 **状态监控** - 查看运行状态、内存占用
- 📝 **日志管理** - 实时日志 + 历史日志归档（自动轮转，保留7天）
- 🎨 **Web UI** - 一键打开 Web 控制面板 (zash/metacubexd/yacd)
- 🔄 **内核更新** - 自动检查更新，支持 GitHub 镜像加速
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

### 1. 下载内核

```bash
# 默认直连下载
mihomo kernel

# 国内网络使用镜像加速
mihomo kernel --mirror

# 或指定镜像
mihomo kernel --mirror hk.gh-proxy.org
```

### 2. 添加订阅

```bash
mihomo sub add "https://your-subscription-url" "my-proxy"
```

### 3. 启动代理

```bash
# Mixed 模式（默认）
mihomo start

# 切换到 TUN 模式（透明代理，需要管理员权限）
mihomo start tun

# 再次执行 start = 重启 / 切换模式
```

### 4. 打开 Web UI

```bash
mihomo ui          # 默认 zash
mihomo ui dash     # metacubexd
mihomo ui yacd     # YACD
```

## 命令参考

### 核心命令

| 命令                        | 说明                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `mihomo start [tun\|mixed]` | 启动/重启/切换代理模式                                                       |
| `mihomo stop`               | 停止代理                                                                     |
| `mihomo status`             | 查看运行状态                                                                 |
| `mihomo log`                | 实时查看日志 (`-o` 用系统编辑器打开)                                         |
| `mihomo logs`               | 列出所有日志（当前 + 历史归档）                                              |
| `mihomo logs <编号>`        | 查看指定日志（`0`=当前日志，`1+`=归档日志，支持 `-n N` 指定行数、`-o` 打开） |

### 订阅管理

| 命令                          | 说明                                   |
| ----------------------------- | -------------------------------------- |
| `mihomo sub`                  | 列出所有订阅（含流量、到期时间）       |
| `mihomo sub add <url> [name]` | 添加订阅                               |
| `mihomo sub update`           | 更新所有订阅                           |
| `mihomo sub update <name>`    | 更新指定订阅（支持模糊匹配）           |
| `mihomo sub use <name>`       | 切换当前订阅（支持模糊匹配，自动重启） |
| `mihomo sub web [name]`       | 打开订阅页面（无参打开默认）           |

### 覆写配置

| 命令                           | 说明                       |
| ------------------------------ | -------------------------- |
| `mihomo ow` / `mihomo ow list` | 查看覆写配置状态和文件列表 |
| `mihomo ow on`                 | 启用覆写配置（自动重启）   |
| `mihomo ow off`                | 禁用覆写配置（自动重启）   |

### 其他命令

| 命令                              | 说明                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `mihomo kernel [--mirror [镜像]]` | 更新内核（默认直连，`--mirror` 使用镜像）                           |
| `mihomo update`                   | 更新 mihomo-cli (npm install -g)                                    |
| `mihomo ui [zash\|dash\|yacd]`    | 打开 Web UI                                                         |
| `mihomo dir`                      | 显示数据目录位置                                                    |
| `mihomo dir open [target]`        | 打开指定目录（`root`, `subs`, `logs`, `kernel` 等）                 |
| `mihomo reset [目标...] [--full]` | 重置用户数据（可用目标：`subs`, `logs`, `kernel`, `overwrites` 等） |
| `mihomo version`                  | 显示版本信息                                                        |
| `mihomo help`                     | 显示帮助信息                                                        |

### 命令别名

以下任意命令等效：

- `mihomo-cli` (原名)
- `mihomo`
- `mhm`
- `mh`

### 快捷命令

常用操作的快捷方式：

| 快捷命令               | 等效于                     |
| ---------------------- | -------------------------- |
| `mihomo up`            | `mihomo start`             |
| `mihomo down`          | `mihomo stop`              |
| `mihomo tun`           | `mihomo start tun`         |
| `mihomo use <name>`    | `mihomo sub use <name>`    |
| `mihomo on` / `off`    | `mihomo ow on` / `ow off`  |
| `mihomo open <target>` | `mihomo dir open <target>` |

## 模式说明

### Mixed 模式（默认）

- HTTP + SOCKS5 混合端口
- 无需管理员权限
- 需要手动配置应用代理

### TUN 模式（透明代理）

- 全局自动路由，所有流量自动走代理
- 需要 sudo / 管理员权限
- 首次使用会自动配置 DNS 和路由

## 内核更新镜像

国内网络可使用镜像加速 GitHub 下载：

```bash
# 默认直连（不使用镜像）
mihomo kernel

# 使用默认镜像 (v6.gh-proxy.org)
mihomo kernel --mirror

# 指定镜像
mihomo kernel --mirror hk.gh-proxy.org

# API 请求和下载都使用镜像（解决 API 访问受限问题）
mihomo kernel --mirror-all
mihomo kernel --mirror-all hk.gh-proxy.org
```

**可用镜像：**

| 镜像                   | 说明     |
| ---------------------- | -------- |
| `v6.gh-proxy.org`      | 默认镜像 |
| `gh-proxy.org`         | 官方     |
| `hk.gh-proxy.org`      | 香港     |
| `cdn.gh-proxy.org`     | CDN      |
| `edgeone.gh-proxy.org` | EdgeOne  |

## 订阅自动更新

- 默认更新间隔：12 小时（或订阅服务端指定的 `profile-update-interval`）
- 触发时机：`start` 命令、`sub list` 命令
- 更新失败时继续使用本地缓存，不影响使用

## 数据目录

用户数据存储位置（与安装位置分离，更新不丢失）：

```
~/.mihomo-cli/
├── settings.json         # 用户设置（订阅列表等）
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
    └── config.yaml       # 运行时生成的配置
```

可通过环境变量 `MIHOMO_CLI_DIR` 自定义数据目录位置。

## 覆写配置

覆写配置允许你在订阅配置基础上进行自定义修改，而不会影响订阅本身。

### 使用方法

1. 在 `~/.mihomo-cli/` 目录下创建覆写文件：
   - `overwrite.yaml` — 主覆写文件
   - `overwrite.dns.yaml` — 按功能拆分的扩展文件（`overwrite.*.yaml` 格式）
2. `overwrite.yaml` 始终最先加载，扩展文件按文件名排序加载
3. 使用 `mihomo ow on` 启用覆写配置（会自动重启）

### 特殊语法

覆写配置支持以下特殊操作符：

| 语法     | 作用                           | 示例                 |
| -------- | ------------------------------ | -------------------- |
| `key!`   | 强制覆盖整个对象（不深度合并） | `dns!`: { ... }      |
| `+key`   | 数组前置插入                   | `+proxies`: [...]    |
| `key+`   | 数组追加                       | `rules+`: [...]      |
| `<+key>` | 键名以 `+` 开头时转义          | `<+.google.cn>`: ... |

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

## Web UI

内置三个常用 Web UI：

| 名称 | 地址                                     | 说明                 |
| ---- | ---------------------------------------- | -------------------- |
| zash | <https://board.zash.run.place>           | 现代简洁界面（默认） |
| dash | <https://metacubex.github.io/metacubexd> | MetaCubeX 官方 UI    |
| yacd | <https://yacd.metacubex.one>             | 经典 YACD 界面       |

## 故障排除

### 进程无法停止

```bash
sudo pkill -9 mihomo
```

### TUN 模式无法启动

1. 确保使用 sudo / 管理员权限
2. 检查是否有其他程序占用 53 端口
3. 查看日志：`mihomo log`

### 订阅更新失败

- 检查网络连接
- 确认订阅 URL 有效且未过期
- URL 中的 token 等敏感信息会自动脱敏

### 端口被占用

默认端口（取决于订阅配置）：

- Mixed 端口: `7890`
- 外部控制器: `127.0.0.1:9090`

## 安全特性

- **URL 脱敏**：订阅 URL 中的 token、key、password 等敏感参数自动替换为 `***`
- **文件权限**：配置文件使用 `0o600` 权限（仅所有者可读可写），目录使用 `0o700` 权限
- **信号处理**：优雅处理 SIGINT/SIGTERM 信号
- **异常捕获**：全局 uncaughtException 和 unhandledRejection 处理

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。

## 相关项目

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) - mihomo 内核
- [MetaCubeX/metacubexd](https://github.com/MetaCubeX/metacubexd) - Web UI
- [MetaCubeX/Yacd-meta](https://github.com/MetaCubeX/Yacd-meta) - YACD Web UI

## 免责声明

本工具仅供学习和研究使用。使用本工具时请遵守当地法律法规。
