# mihomo-cli

一个基于命令行的 mihomo (Clash.Meta) 客户端，支持 macOS、Windows 和 Linux。

## 功能特性

- 🌐 **订阅管理** - 添加和更新订阅链接
- 🚀 **进程管理** - 启动、停止、重启 mihomo 内核
- 🔄 **双模式支持** - Mixed 模式和 TUN 透明代理模式
- 📊 **状态监控** - 查看运行状态、内存、CPU 占用
- 📝 **日志查看** - 实时查看运行日志
- 🎨 **Web UI** - 一键打开 Web 控制面板 (zash/metacubexd/yacd)
- 🔄 **内核更新** - 自动检查并更新 mihomo 内核
- 💻 **跨平台** - 支持 macOS、Windows、Linux

## 安装

### 方式一：npm 全局安装

```bash
npm install -g mihomo-cli
```

### 方式二：源码安装

```bash
# 克隆仓库
git clone https://github.com/yourname/mihomo-cli.git
cd mihomo-cli

# 安装依赖
npm install

# 全局链接（可选）
npm link
```

### 方式三：使用预编译二进制

从 [Releases](https://github.com/yourname/mihomo-cli/releases) 页面下载对应平台的二进制文件。

## 快速开始

### 1. 下载内核

```bash
mihomo-cli kernel
```

### 2. 添加订阅

```bash
mihomo-cli sub add "https://your-subscription-url" "my-proxy"
```

### 3. 启动代理

```bash
# Mixed 模式（默认）
mihomo-cli start

# TUN 模式（需要管理员权限）
mihomo-cli start tun
```

### 4. 打开 Web UI

```bash
mihomo-cli ui
```

## 命令参考

### 核心命令

| 命令 | 说明 |
|------|------|
| `mihomo-cli start [tun|mixed]` | 启动代理 (默认 mixed) |
| `mihomo-cli stop` | 停止代理 |
| `mihomo-cli restart` | 重启代理 |
| `mihomo-cli status` | 查看运行状态 |
| `mihomo-cli log` | 实时查看日志 |
| `mihomo-cli clean` | 清理残留进程 |

### 订阅管理

| 命令 | 说明 |
|------|------|
| `mihomo-cli sub list` | 列出所有订阅 |
| `mihomo-cli sub add <url> [name]` | 添加订阅 |
| `mihomo-cli sub update [name]` | 更新订阅 |

### 其他命令

| 命令 | 说明 |
|------|------|
| `mihomo-cli kernel` | 更新内核到最新版本 |
| `mihomo-cli ui [zash|dash|yacd]` | 打开 Web UI |
| `mihomo-cli dirs` | 显示数据目录位置 |
| `mihomo-cli version` | 显示版本信息 |
| `mihomo-cli help` | 显示帮助信息 |

## 模式说明

### Mixed 模式（默认）

- HTTP + SOCKS5 混合端口
- 无需管理员权限
- 需要手动配置应用代理

### TUN 模式（透明代理）

- 全局自动路由，所有流量自动走代理
- 需要 sudo/管理员权限
- 首次使用会自动配置 DNS 和路由

## 数据目录

用户数据存储位置（与安装位置分离，更新不丢失）：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/mihomo-cli/` |
| Windows | `%APPDATA%\mihomo-cli\` |
| Linux | `~/.config/mihomo-cli/` |

目录结构：

```
mihomo-cli/
├── config/
│   ├── config.yaml    # 当前配置
│   ├── override.yaml  # 覆盖配置（TUN/DNS 设置）
│   └── settings.json  # 用户设置（订阅列表、内核版本）
├── data/
│   ├── pid            # 进程 PID
│   ├── cache.db       # 缓存数据库
│   ├── geoip.metadb   # GeoIP 数据库
│   └── geosite.dat    # GeoSite 数据库
└── logs/
    └── mihomo.log     # 运行日志
```

## Web UI

内置三个常用 Web UI：

| 名称 | 地址 | 说明 |
|------|------|------|
| zash | https://board.zash.run.place | 现代简洁界面（默认） |
| dash | https://metacubex.github.io/metacubexd | MetaCubeX 官方 UI |
| yacd | https://yacd.metacubex.one | 经典 YACD 界面 |

## 故障排除

### 进程无法停止

```bash
# macOS/Linux
sudo pkill -9 mihomo

# Windows (管理员 PowerShell)
taskkill /F /IM mihomo.exe
```

### TUN 模式无法启动

1. 确保使用 sudo/管理员权限
2. 检查是否有其他程序占用 53 端口
3. 查看日志获取详细错误信息：`mihomo-cli log`

### 订阅更新失败

- 检查网络连接
- 确认订阅 URL 有效且未过期
- URL 中的 token 等敏感信息会被自动脱敏

### 端口被占用

默认端口（取决于订阅配置）：
- Mixed 端口: `7890`
- 外部控制器: `127.0.0.1:9090`

## 安全特性

- **URL 脱敏**：订阅 URL 中的 token、key、password 等敏感参数在错误信息和日志中自动替换为 `***`
- **文件权限**：配置文件使用 `0o600` 权限（仅所有者可读可写），目录使用 `0o700` 权限
- **信号处理**：优雅处理 SIGINT/SIGTERM 信号，防止数据损坏
- **异常捕获**：全局 uncaughtException 和 unhandledRejection 处理

## 发布

### npm 发布

```bash
# 登录 npm
npm login

# 发布（需要先更新版本号）
npm publish --access public
```

### 打包二进制

```bash
# 使用 pkg 打包
npm run pkg

# 输出在 dist/ 目录
```

## 开发

```bash
# 克隆仓库
git clone https://github.com/yourname/mihomo-cli.git
cd mihomo-cli

# 安装依赖
npm install

# 运行
node index.js help

# 检查代码
npm run lint

# 打包二进制
npm run pkg
```

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。

## 相关项目

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) - mihomo 内核
- [MetaCubeX/metacubexd](https://github.com/MetaCubeX/metacubexd) - Web UI
- [MetaCubeX/Yacd-meta](https://github.com/MetaCubeX/Yacd-meta) - YACD Web UI

## 免责声明

本工具仅供学习和研究使用。使用本工具时请遵守当地法律法规。
