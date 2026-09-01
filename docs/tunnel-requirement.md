# 需求：ssh 隧道出口（`tunnel` 子命令）

> 状态：**已实现**（v3.8.0）。实现落点见 `src/tunnel.ts` + `src/commands/tunnel.ts`，
> 五个设计问题的最终答复见文末「实现记录」。

## 一句话

管理 `ssh -D` 动态转发进程的生命周期，让 mihomo 能把内网域名分流到公司内网，
且 `mh up` 一个动作同时拉起内核与隧道。

## 背景

办公室有台机器（ssh 别名 `m4`，经反向隧道从家可达）。在家执行：

```bash
ssh -D 1080 -N m4
```

本地 `1080` 即成为 SOCKS5 代理，出口在公司内网。配合覆写规则即可分流内网域名：

```yaml
# 形态参考，用户本机 overwrite.seal.yaml 已是同类出口
+proxies:
  - {name: Tunnel-Host, type: socks5, server: 127.0.0.1, port: 1080}
+proxy-groups:
  - {name: Tunnel, type: select, proxies: [Tunnel-Host, DIRECT]}
+rules:
  - DOMAIN-SUFFIX,<内网域名>,Tunnel
  - IP-CIDR,10.0.0.0/8,Tunnel
```

**覆写机制本身已经够用，本需求要补的只有一件事：ssh 隧道的生命周期管理。**
隧道断了 mihomo 不知情，会一直往死端口送流量。

## 命令面

```
mh tunnel add <名字> --host m4 --port 1080 [--no-auto]
mh tunnel up|down|status [名字]
mh tunnel rm <名字>
```

- `up` 时生成 `overwrite.tunnel-<名字>.yaml`，`down` 不删文件
- 子命令组别名沿用现有风格（如 `tunnel` = `tun`? **注意 `tun` 已被 TUN 模式占用**，
  需另选别名或不设）

## 与主命令的联动

| 命令 | 行为 |
| --- | --- |
| `mh up` | 顺带拉起 `auto: true` 的隧道；`--no-tunnel` 跳过 |
| `mh down` | 连带停隧道，**但只停 `up` 自己起的** |
| `mh status` | 一并展示隧道状态 |

**隧道起不来时内核照常启动，只警告不算失败**——隧道只影响内网分流那部分规则，
其余流量照常走订阅节点，让整个 `up` 失败是过度反应。但警告必须显眼，不能淹没在正常输出里。

**`down` 要区分「谁起的」**：手动 `tunnel up` 起的不该被 `mh down` 带走；
否则下次 `up` 又起一个，累积僵尸进程。

## 覆写冲突：同名时 tunnel 优先

> **实现后修正**：这条只在「用户不主动声明同名节点」时成立。`~` 保证同名只留一条，
> 但字段层面仍是后加载者胜。详见文末「实现记录 2」。

生成的覆写文件可能与用户已有配置声明同名的 proxies / proxy-groups
（用户本机 `overwrite.seal.yaml` 就是同类出口）。规则是**同名时 tunnel 优先**，
但实现上有两个坑：

1. **不要在代码里认任何具体文件名或组名**（不要写死 `Seal`）。用通用的同名覆盖逻辑
2. **不能靠文件名字母序保证优先级**。现有加载顺序是字母序（`overwrite.yaml` 除外），
   `overwrite.tunnel-*.yaml` 恰好排在 `seal` 之后纯属巧合，用户再加个
   `overwrite.zzz.yaml` 就压过去了
3. **`+proxies` 是数组前置插入、不做按名去重**，同名 proxy 会并存两条，
   mihomo 取哪条不确定。用 `~proxies`/`~proxy-groups`（按 `name` 就地合并）
   还是别的方式，实现前评估并给方案

用户会自行 `ow off` 掉冲突的覆写文件，不需要代码去处理别人的文件。

## 硬约束

**1. ssh 参数一个都不能少**

```
-N -o ExitOnForwardFailure=yes -o BatchMode=yes
   -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15
```

| 选项 | 缺了会怎样 |
| --- | --- |
| `ExitOnForwardFailure` | 「连上了但转发没建起来」的假活：进程在、端口不通，而 mihomo 还在往那儿送流量 |
| `BatchMode` | 任何交互提示都会挂死（无 TTY 时尤其） |
| `ConnectTimeout` | 网络半死不活时 ssh 久等，期间看起来还活着 |
| `ServerAlive*` | 断线后进程不退出，端口成僵尸 |

**2. `-D` 只绑 `127.0.0.1`，绝不能绑 `0.0.0.0`**

后者会让同一 WiFi 下任何设备都能经本机进公司内网。这是安全红线。

**3. `status` 要真实探测端口在监听**，不能只看进程在不在——那正是上面「假活」的表现。

**4. 起之前先检测端口占用**，不要盲启后失败。

**5. 复用现有进程管理范式**：`src/process.ts` 的 `isProcessRunning` 那套、
`src/runtime.ts` 的门面思路，不要引入第二套进程管理。

## 暂不做：自动重连保活

`ssh -D` 断线后端口消失，mihomo 毫不知情、继续往死端口送，
表现是**内网域名全超时但 mihomo 显示一切正常**。

先靠 `ServerAliveInterval` 让断线进程自己退出 + `status` 能查出来。
保活是完整方案，但 `daemon.ts` 那套涉及 launchd 与管理员权限，扩展成本不小；
且真正需要保活的场景（长时间在外）与临时查个内网链接是两回事。**等实际用起来再评估。**

## 为什么这么设计

诉求是「`mh up` 一个动作同时拉起两者」。四种做法比较后选了独立子命令 + `auto` 标记：

| 方案 | 结论 |
| --- | --- |
| A `up` 里顺带起，配置进 settings | 否决：`up`/`down` 语义膨胀成「启动全套」，隧道失败时成败难定义 |
| B 覆写文件里声明依赖 | 否决：覆写是 mihomo 的配置格式，塞自定义字段越界，且要防漏传给内核 |
| **C 独立子命令 + `auto` 自动带起** | **选中** |
| D 只检查不管理，打印命令让人自己跑 | 否决：没解决诉求 |

**选 C 的关键理由是排障**：隧道与内核的失败模式完全不同——内核是配置错/端口占用/
内核文件损坏，隧道是网络不通/ssh 密钥/目标机没开机/跳板挂了。若只有 `up`，
隧道失败时只能看到「启动失败」，得翻日志才知道是哪一半。独立的 `tunnel status`
才能一眼定位。「一个动作」的诉求由 `auto: true` 满足。

## 实现前先给方案

读完 `src/process.ts`、`src/runtime.ts`、`src/settings.ts`、`src/overwrite.ts`、
`src/commands/registry.ts`、`src/commands/daemon.ts` 后，先说清楚这几点再动手：

1. 隧道进程状态存哪（settings.json 还是 runtime 目录）、`down` 怎么区分「谁起的」
2. 同名 proxies/proxy-groups 的覆盖用什么机制，如何**不依赖文件名顺序**
3. 生成的覆写文件与用户手写的如何共存，`tunnel rm` 要不要删文件
4. `tunnel` 的子命令别名怎么取（`tun` 已被 TUN 模式占用）
5. `up` 里隧道失败的警告怎么呈现

---

## 实现记录

### 1. 状态存哪 · `down` 怎么区分「谁起的」

配置（`name`/`host`/`port`/`auto`）进 `settings.json` 的 `tunnels`；运行态
（`pid`/`started_by`/`started_at`/`port`）进 **`<数据目录>/tunnel/<名字>.json`**，一条隧道一个文件。

**运行态绝不能放 `runtime/`**：`process.ts` 的 `clearRuntime()` 会 `rmrf` 整个 runtime 目录，
而 `stop()` 成功路径必调它——状态会连同 `config.yaml` 一起被抹掉，「谁起的」标记就此丢失。

「谁起的」= `started_by: 'auto' | 'manual'`。`start` 拉起的记 auto，`tunnel up` 记 manual，
`stop` 只停 auto。**单向提升**：`tunnel up` 一条已在跑的 auto 隧道会提升为 manual；
manual 永不降级（用户显式要过它，就不该被 `stop` 带走）。`start` 遇到已在跑的隧道跳过且不改标记。

PID 复用防护沿用「存活 + 命令行匹配」双条件，needle 取 `-D 127.0.0.1:<端口>`——
紧跟 `ssh` 之后偏移极小，不会撞上 BSD `ps` 的 79 列截断（单测有断言）。

### 2. 同名覆盖机制

用 **`~proxies` / `~proxy-groups`**（按 name 就地合并）。它按 name 在数组里定位，
不像 `+proxies` 那样并存两条再靠去重「保留第一个」——后者的胜负完全取决于文件加载顺序。

**已实测的局限（重要）**：`~` 保证的是「同名只留一条」，**不保证 tunnel 的字段一定胜出**。
造一个字母序更靠后的 `overwrite.zzz.yaml` 声明同名节点，实测后加载的文件会覆盖
`server`/`port` 并残留自己的额外字段（如 `username`）。`~` 是**字段级合并**，
当前覆写语法没有「按 name 整体替换」的写法（`~key!` 的 `!` 被分支优先级吞掉）。

因此本需求「同名时 tunnel 优先」只在**用户不主动声明同名节点**时成立。
好在覆写文件由用户维护、冲突可见（`mihomo ow` 能列出全部文件），
真冲突时按原计划由用户自行处置。彻底解决需要扩展覆写语法，超出本需求范围。

### 3. 生成文件与用户手写共存 · `rm` 是否删文件

覆写文件**由用户维护**：CLI 只在文件不存在时生成模板（`add` 时建，`up` 时若缺失则补建），
此后永不改写。模板只给 socks5 节点与 select 分组，**分流规则以注释形式留白**——
CLI 无从知道用户的内网域名。

**`tunnel rm` 不删覆写文件**，只删 settings 条目、停进程、清运行态，并打印文件路径提示自行处置。
删用户手写的分流规则不可恢复。

注意既有联动：`overwrite.tunnel-*.yaml` 会被 `isOverwriteFilename` 匹配，
故 `reset ow` / `reset --full` 会连带删掉它（默认的 `mihomo reset` 不含 overwrites）。
另新增了 `reset tunnel` 目标，它会先停进程再删运行态目录（`onBefore` 钩子）——
反序会导致 ssh 进程失联、继续占着端口且 CLI 再也停不掉。

### 4. 子命令别名

注册 `tunnel` + **`ssh`** + `tunnels`。`tun` 已被 TUN 模式占用，
且注册表的重复 token 校验是模块顶层 throw，撞车会「启动即炸」。
归入 `system` 组，与 `daemon` 同档（都是管一个后台进程的生命周期）。

### 5. 失败警告呈现

沿用全仓最显眼的既有形态（`reset` 的运行中警告）：前后空行 + `colors.yellow('警告: ...')`，
不引入 emoji 或新符号。不吞原因——ssh 的 stdout/stderr 重定向到
`logs/tunnel-<名字>.log`（每次启动 `'w'` 截断，不会无限增长），失败时读尾部拼进提示。
实测能如实带出 `ssh: Could not resolve hostname ...` 这类真实原因。
`start` 收尾的 `printStatus()` 里还有隧道段，同一异常会二次可见。

### 端到端实测结论

localhost ssh 实测覆盖：真实启停、`lsof` 确认只绑 `127.0.0.1`（未绑 `0.0.0.0`）、
端口占用时拒绝启动、`--host -oProxyCommand=...` 注入被拒（`/tmp/pwned` 未生成）、
manual 隧道不被 `stop` 带走 / auto 隧道被带走、非交互 `rm` 退出码为 1、
失败后不留陈旧状态文件。

**「假活」检测的边界**：状态判定为「进程在 + 端口不通」。注意 `kill -STOP` 制造不出假活——
socket 仍在内核 backlog 里可连，此时报「运行中」是正确的。真正的假活是
ssh 进程活着但转发未建立（如认证挂起、`ProxyCommand` 卡住），实测该场景能正确报出。
