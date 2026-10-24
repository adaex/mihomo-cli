# 安全策略

## 支持范围

只有 npm 上的最新版本会收到安全修复。本项目是单人维护的个人工具，不维护旧版本分支——请先 `mihomo-cli update` 升到最新版再报告问题

## 报告漏洞

**不要开公开 issue。** 请走 GitHub 的私密渠道：

- [Security Advisory](https://github.com/adaex/mihomo-cli/security/advisories/new)（推荐）

请尽量附上复现步骤、受影响版本和 `mihomo-cli doctor` 输出。输出可能包含订阅名称、路径、URL 或错误详情；自动脱敏不能识别所有自定义凭据，分享前必须人工检查

修复后会在 CHANGELOG 的「安全」分组记录。作为个人项目，这里不承诺响应时限

## 信任边界

### 内核二进制来自上游 GitHub Release

CLI 下载 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) 的 release 资产并 `chmod 755`，约束如下：

- 资产地址在拼接任何镜像前缀**之前**校验（`assertTrustedAssetUrl`）：必须是 https，主机在白名单内（`github.com`、`api.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`）
- GitHub API **不经过镜像**，镜像只在用户显式传入 `--mirror` 时作为下载传输层，不在自动候选中
- `gh` 通道按精确资产名下载，拒绝 glob 元字符与路径成分
- curl 通道强制初始与重定向全链路 https、限制大小，下载后比对 `asset.size`
- 上游 darwin 资产为单文件 gzip：经 `gzip -dc` 解出，随后执行二进制自检（`-v`）并与 release tag 对账，通过后才原子替换旧内核

**上游目前未提供 checksums 文件**，因此完整性依赖来源约束、传输层校验、大小比对和执行自检，不是哈希或签名验证

第三方镜像可以决定实际传输的内容，CLI 无法证明镜像产物与上游完全相同。只有明确接受这层信任时才使用 `--mirror`，优先使用 gh 或 GitHub HTTPS 通道

### 在线 Web UI 是需要信任的控制端

`mihomo-cli ui` 只打开在线网页，不随 CLI 分发或托管前端。页面需要联网，并会连接本机控制器；其前端代码与分发方属于信任边界。地址、密钥与剪贴板注意事项见 [README「Web UI」](README.md#web-ui)

### 外部控制器默认无鉴权

外部控制器默认监听 `127.0.0.1:9090` 且无鉴权：仅本机回环可达、局域网不可达，但本机其他进程和浏览器网页可能访问它。不可信的多用户环境应在 `settings.json` 设置 `controller_secret`，具体配置见 [README「安全特性」](README.md#安全特性)

### 订阅凭据与展示脱敏

原始订阅 URL 与下载到的配置**以明文存放**在数据目录（默认 `~/.mihomo-cli`），依赖文件系统权限保护、不做加密

展示脱敏只降低泄漏概率，不是完整的安全边界；分享输出前必须人工检查。具体脱敏规则、文件权限和 `config --reveal` 的明文展示见 [README「安全特性」](README.md#安全特性)

### JS 覆写是全信任代码

覆写脚本以当前用户身份全信任运行，不沙箱、不超时，不要安装来路不明的脚本。`ow` / `status` 也会加载模块并执行顶层代码，不能把 `status` 当成不执行用户代码的安全扫描器

完整执行入口与契约见 [覆写配置详版](docs/overwrite.md#js-覆写脚本)

### 提权与代理设置范围

- CLI 本身**拒绝以 root 运行**（`sudo mihomo-cli …` 会直接报错）
- Mixed 由用户级 LaunchAgent（`gui/<uid>`）托管，正常服务操作免密；清理 root 属主的 TUN 残留时可能按需请求管理员密码
- TUN 按需 `sudo` 启动临时进程，用 `mihomo-cli stop` 清理
- CLI **从不自动修改 macOS 系统代理**，也不提供全局 `proxy on/off`；需要代理的具体浏览器或应用自行配置 Mixed 地址。系统代理相关能力只读，不写入系统设置

### 平台

仅支持 macOS。非 macOS 上直接报错退出，不提供部分可用的降级路径
