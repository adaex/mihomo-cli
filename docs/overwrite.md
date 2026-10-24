# 覆写配置

本文是覆写机制的详细用户文档；命令与生效时机见 [README 命令参考](../README.md#覆写与配置) 和 [状态与生效](../README.md#状态与生效)。本文件是文件格式、执行顺序、YAML 操作符、JS 脚本契约与 match 语义的唯一详版

覆写在订阅配置基础上做自定义修改，原始订阅文件保持独立。新增节点是否进入现有分组由 mihomo 的 `include-all` / `include-all-proxies` 等原生语义决定；需要排除时，在相应分组显式配置 `exclude-filter`

## 文件与加载顺序

在 `~/.mihomo-cli/` 下按需创建：

- `overwrite.yaml`：YAML 主文件，只认 `.yaml`，主文件写成 `overwrite.yml` 不会加载
- `overwrite.*.yaml` / `overwrite.*.yml`：YAML 扩展文件
- `overwrite.js` / `overwrite.mjs` / `overwrite.cjs`：JS 主脚本
- `overwrite.*.js` / `overwrite.*.mjs` / `overwrite.*.cjs`：JS 扩展脚本

加载顺序为：全部 JS 脚本 → 全部 YAML。各段内主文件优先，扩展文件按文件名码点排序；`ow` 列表与合并使用同一顺序。脚本先做程序化结构变换，YAML 再做声明式微调

覆写默认启用。放好文件后执行 `mihomo-cli start` 应用；曾执行 `ow off` 时需先 `ow on`

## YAML 合并语法

操作符只在覆写文件顶层生效：

| 语法 | 作用 | 示例 |
| --- | --- | --- |
| `key!` | 强制替换整个值，不做深度合并 | `dns!:` |
| `+key` | 数组前置插入 | `+proxies:` |
| `key+` | 数组追加 | `rules+:` |

普通键对映射逐键深度合并，对数组整体替换。带条件的修改，例如按 `name` 查找元素、找不到时跳过或追加，应写 JS 脚本，不引入更多声明式操作符

`~key` / `~?key` / `<key>` 不是现行语法，写入会报错并提示改用 JS 脚本

嵌套映射中的键一律按字面名合并，`+` / `!` 不再被解释为操作符。这允许直接使用 mihomo 原生通配键：

```yaml
dns:
  nameserver-policy:
    '+.corp.example.com': 'https://dns.corp.example.com/dns-query'
hosts:
  '+.google.cn': 8.8.8.8
```

嵌套数组需要写全量值。`+key` / `key+` 的目标已存在但不是数组时会直接报错，不会静默包成新数组

`+rules` 的内容位于订阅规则之前，不受前面的脚本重组影响；多个文件都使用前插时，后加载文件的前插内容会更靠前

## JS 覆写脚本

脚本默认导出一个**同步**函数，就地修改传入的 `config`，返回值忽略。脚本没有 `match` 或单文件 `enabled` 声明，作用域判断写在函数里，临时停用时改扩展名（如追加 `.bak`）

```js
// ~/.mihomo-cli/overwrite.custom.js
// 只对 edu 系订阅、且订阅主机属于 glados-config.com 时继续
export default function (config, ctx) {
  const { name, host } = ctx.subscription;
  if (!name.startsWith('edu')) return;
  if (host !== 'glados-config.com' && !host.endsWith('.glados-config.com')) return;

  const developer = (config['proxy-groups'] || []).find(g => g && g.name === 'Developer');
  if (developer) {
    developer['default-selected'] = 'TW Fixed IP';
  } else {
    ctx.warn('当前订阅无 Developer 分组，跳过 default-selected 注入');
  }
}
```

`default-selected` 的优先级低于 `store-selected` 缓存的历史选择。若之前手动选过且开启了 `store-selected`，需 `mihomo-cli reset data` 清缓存后才能看到默认值接管

可用上下文：

| 字段 | 内容 |
| --- | --- |
| `ctx.subscription.name` | 当前订阅名 |
| `ctx.subscription.url` | 订阅原始 URL |
| `ctx.subscription.host` | 预解析的 URL hostname，解析失败为空串 |
| `ctx.mode` | 本次构建模式：`'mixed'` 或 `'tun'` |
| `ctx.warn(message)` | 添加配置提示，`config` / `doctor` / `start` 可见，`status` 不执行变换也不显示该提示 |

约定与安全边界：

- **必须同步**：返回 Promise 会报错
- **全信任**：脚本以当前用户身份运行，不沙箱、不超时，不要安装来路不明的脚本
- **执行顺序**：脚本看到的是订阅原始配置，读不到后续 YAML 注入内容
- **系统锁定项不可改**：脚本输出中的入站与控制面锁定键会在之后剥除并提示
- **`ow` / `status` 也会加载模块**：模块顶层代码随之执行；`status` 不调用导出的变换函数，但不能被理解为不执行任何用户代码
- **变换函数的执行入口**：`config` / `doctor` / `start` 构建配置时调用；`doctor` 也会执行变换，以便做真实校验
- **加载与执行错误**：`ow` / `status` 显示加载失败但保持列表可用；`config` / `doctor` / `start` 对加载或变换错误硬失败并给出文件名

`status` 的覆写主清单和 JSON 的 `overwrite.applied` 只表示文件已被选中；对 JS 脚本而言，不表示它适用于当前订阅或实际修改了配置

## 作用域限定（match）

YAML 覆写可在顶部添加 `match:`，只对指定订阅参与合并；无 `match` 则全局参与。多个键之间为 AND，同一键的数组值之间为 OR：

| 匹配键 | 作用 |
| --- | --- |
| `name` | 按订阅名匹配，大小写不敏感；支持尾部 `*` 表示前缀、头部 `*` 表示后缀 |
| `url-domain` | 按订阅 URL hostname 匹配裸域名：完全相等或为其子域，不支持通配符 |

`name` 只支持上述两种通配，多 `*`、中间 `*`、`?`、单独 `*` 都会报错；更复杂的匹配写 JS 脚本：

| 写法 | 命中 | 不命中 |
| --- | --- | --- |
| `edu*` | `edu1`、`edu2`、`edu-hk` | `mini1`、`xedu1` |
| `"*edu"` | `miniedu` | `edu1` |
| `edu1` | `edu1` | `edu10` |

以 `*` 开头的 YAML 标量必须加引号，写成 `name: "*edu"`。未加引号会解析失败：`ow` / `status` 显示加载错误，`config` / `start` / `doctor` 拒绝继续，不会把错误文件当成全局覆写

`match` 键名错误、值为空或空块都会直接报错。`url-domain` 会命中该域名及其子域下的所有订阅；同一机场有多条订阅时，需要按套餐区分就用 `name: edu*`

`status` 只对 YAML 区分「选中」与「不适用」：

```text
覆写: 已启用 (seal，1 个不适用，1 个已禁用)
```

「不适用」表示 YAML 文件启用但 `match` 未命中；「已禁用」表示文件内 `enabled: false`。两者只计数，具体文件名在 `mihomo-cli ow` 中查看。加载错误进入 `overwrite.errors`，不会混入 `overwrite.applied`

## 单个 YAML 文件的开关（enabled）

```yaml
# ~/.mihomo-cli/overwrite.seal.yaml
enabled: false

+proxies:
  - name: Seal-Host
    type: socks5
    server: 127.0.0.1
    port: 1080
```

- 不写 `enabled` 即启用；停用的文件仍在 `ow` 列表中标注
- `enabled` 必须与 `match` 一样小写且不带操作符，`enabled!`、`+match`、`Enabled` 都会报错
- 必须写布尔值 `false`；`no`、`off`、`"false"` 都不是可接受的布尔值，CLI 会报错而不是猜测意图
- `enabled` 和 `match` 是 CLI 元数据，不会进入最终 mihomo 配置

## YAML 示例

```yaml
# ~/.mihomo-cli/overwrite.yaml
# 强制替换整个 dns 段
dns!:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 223.5.5.5

# 放在订阅规则之前，避免被已有 MATCH 提前匹配
+rules:
  - 'DOMAIN-SUFFIX,example.com,DIRECT'
```

## 同时使用多个机场

本 CLI 不合并多条活跃订阅。要把第二个机场的节点并入当前配置，用覆写引入 mihomo 原生 `proxy-providers`，节点池由内核按 `interval` 刷新：

```yaml
# ~/.mihomo-cli/overwrite.providers.yaml
proxy-providers:
  second-airport:
    type: http
    url: https://second-airport.example.com/api/v1/client/subscribe?token=xxx
    interval: 86400
    path: ./second-airport.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300

+proxy-groups:
  - name: SecondAirport
    type: select
    use: [second-airport]

+rules:
  - 'DOMAIN-SUFFIX,corp.example.com,SecondAirport'
```

provider 节点与订阅节点可在分组和 Web UI 中选择。若要让订阅已有分组也使用第二机场，写 JS 脚本按 `name` 找到分组并添加 `use`；找不到时用 `ctx.warn` 提示并跳过，不要新建字段不全的分组

## 用 ssh -D 做节点

先运行 `ssh -D 127.0.0.1:1080 -N host`，再把本地端口作为 SOCKS5 节点写入覆写：

```yaml
# ~/.mihomo-cli/overwrite.ssh.yaml
proxies+:
  - {name: SSH-work, type: socks5, server: 127.0.0.1, port: 1080}
+rules:
  - DOMAIN-SUFFIX,example.internal,SSH-work
```
