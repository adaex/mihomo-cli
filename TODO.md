# 待办

记录已评估、明确延后的事项。做的时候先读对应条目，做完删条目。

## Mixed 模式系统代理开关（延后）

**状态**：2026-09 评估，短期不做（维护者用不上）。

**问题**：`mihomo start` 报「已启动」后，用户还得自己去系统设置手动填 HTTP/SOCKS 代理。
进程活着 ≠ 流量走代理，这是 Mixed 模式最大的日常摩擦。

**设计要点**（实现时参考）：

- 命令形态：`mihomo proxy [on|off]`，或 start/stop 联动（settings 记录用户选择）
- 实现：`networksetup -setwebproxy` / `-setsecurewebproxy` / `-setsocksfirewallproxy`，
  对 `networksetup -listallnetworkservices` 列出的每个硬件接口设置；关闭用
  `-setwebproxystate off` / `-setsecurewebproxystate off` / `-setsocksfirewallproxystate off`
- 状态记录在 settings.json（哪些接口被本工具改过），`stop` 时自动关、`start` 时按记录恢复——
  防「stop 后系统代理还指着 7890，全网断网」
- TUN 模式不需要（虚拟网卡接管全局流量），自动跳过
- 注意 Wi-Fi 与以太网接口名本地化（`networksetup` 按服务名操作，中文系统是「Wi-Fi」），
  枚举时跳过带 `*` 前缀的禁用服务
