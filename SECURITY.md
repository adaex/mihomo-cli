# 安全策略

## 支持范围

只有 npm 上的最新版本会收到安全修复。本项目是单人维护的个人工具，不维护旧版本分支——请先 `mihomo update` 升到最新版再报告问题。

## 报告漏洞

**不要开公开 issue。** 请走 GitHub 的私密渠道：

- [Security Advisory](https://github.com/adaex/mihomo-cli/security/advisories/new)（推荐）

请尽量附上：复现步骤、受影响的版本、`mihomo doctor` 的输出（注意它可能含订阅信息，脱敏后再贴）。

修复后会在 CHANGELOG 的「安全」分组记录。作为个人项目，这里不承诺响应时限。

## 信任边界

用户在评估风险时需要知道的几件事，按实际实现说明：

### 内核二进制来自上游 GitHub Release

CLI 会下载 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) 的 release 资产并 `chmod 755`。约束：

- 资产地址在拼接任何镜像前缀**之前**校验（`assertTrustedAssetUrl`）：必须是 https，且主机在白名单内（`github.com`、`api.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`）。被篡改的 `browser_download_url` 无法让 CLI 去下载任意二进制
- GitHub API **不经过镜像**；镜像只作为传输层前缀兜底
- `gh` 通道按精确资产名下载，拒绝 glob 元字符与路径成分
- curl 通道强制初始与重定向全链路 https、有大小上限，下载后比对 `asset.size` 并执行自检
- 解包时同时检查条目路径与类型，**拒绝符号链接与硬链接**成员；遍历用 `lstat` 而非 `stat`（后者会跟随符号链接）

**上游目前未提供 checksums 文件**，因此完整性依赖上述来源约束与传输层校验，而非哈希比对。这是已知局限，不要理解为「已校验哈希」。

使用第三方镜像时，传输完整性由该镜像决定——镜像通道仅在直连不可用时兜底。

### 外部控制器默认无鉴权

`external-controller` 默认监听 `127.0.0.1:9090`，**默认无鉴权**（与 Clash 系工具惯例一致）。它仅监听本机回环、局域网不可达，但**本机其他进程（含浏览器中的网页）可以访问它**。

多用户或不可信的本机环境下，在 `settings.json` 设置 `controller_secret` 启用 Bearer 认证。该字段由系统锁定，订阅与覆写无法伪造。详见 README 的「安全特性」。

### 订阅凭据

订阅 URL 常含 token。CLI 的处理：展示时脱敏（query、userinfo 及路径型令牌），文件权限 `0o600`、目录 `0o700`。但**原始订阅 URL 与下载到的配置以明文存放**在数据目录（默认 `~/.mihomo-cli`）——它依赖文件系统权限保护，不做加密。

### 提权范围

- CLI 本身**拒绝以 root 运行**（`sudo mihomo …` 会直接报错，因为服务是用户级 LaunchAgent，root 下域名错位会让所有服务操作静默失效）
- Mixed 模式全程免密，由用户级 LaunchAgent（`gui/<uid>`）托管
- 只有 TUN 模式按需 `sudo` 启动临时进程（创建 utun 需要 root），用 `mihomo stop` 清理
- 清理遗留的 root LaunchDaemon（v3.0–v4.0 遗留）需要一次管理员密码

### 平台

仅支持 macOS。非 macOS 上直接报错退出，不提供部分可用的降级路径。
