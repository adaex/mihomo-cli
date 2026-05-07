# 代码审查：潜在风险与优化项

> 审查日期：2026-05-07
> 范围：全部 src/ 模块（core + commands）

---

## 高优先级（安全/数据丢失风险）

### 1. Shell 注入 — `execSync` 字符串拼接路径

- **文件**: `src/process.ts:42,86,126,371`, `src/kernel.ts:173,177`, `src/config.ts:286`
- **问题**: `PATHS.mihomoBinary` 等路径通过 `"${path}"` 插入 shell 命令，若路径含 `"` 或 `$()` 可被注入。TUN 模式下以 `sudo` 执行，属本地提权风险。
- **修复**: 统一使用 `spawnSync` 参数数组，`gzip > output` 改用 `fs.createWriteStream` + pipe。

**示例（process.ts 当前）:**
```typescript
execSync(`pgrep -f "${binaryPath}" 2>/dev/null || true`, { encoding: 'utf8' });
```

**修复后:**
```typescript
const result = spawnSync('pgrep', ['-f', binaryPath], { encoding: 'utf8' });
```

**kernel.ts gzip 修复:**
```typescript
// 当前: execSync(`gzip -dc "${tempPath}" > "${outputPath}"`);
// 修复:
const input = fs.createReadStream(tempPath);
const output = fs.createWriteStream(outputPath);
const gunzip = spawn('gzip', ['-dc'], { stdio: ['pipe', 'pipe', 'inherit'] });
input.pipe(gunzip.stdin);
gunzip.stdout.pipe(output);
```

---

### 2. 非原子文件写入 — settings/cache/config

- **文件**: `src/settings.ts` (`writeSettings`, `writeSubscriptionCache`), `src/config.ts` (`writeMihomoConfig`)
- **问题**: `writeFileSync` 如中途崩溃（SIGKILL、磁盘满、断电），文件将被截断为空/不完整。`readSettings` 遇到损坏文件时默认 `{}`，下次写入覆盖丢失所有设置。
- **修复**: 写临时文件 → `fs.renameSync`（POSIX 原子操作）。

**修复模板:**
```typescript
function atomicWriteFileSync(filePath: string, content: string, options?: { mode?: number }) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, options);
  fs.renameSync(tmp, filePath);
}
```

应用于 `writeSettings`、`writeSubscriptionCache`、`writeMihomoConfig`、`writeDebugConfig`。

---

### 3. 测试实例进程泄漏（Ctrl+C）

- **文件**: `src/test-instance.ts`, `src/index.ts` SIGINT handler
- **问题**: `index.ts` 的 SIGINT handler 直接调用 `process.exit(0)`，不执行 `finally` 块。`withTestInstance` 中的 `stopTestInstance` 被跳过，端口 27890 mihomo 进程残留后台。
- **修复**: 在 `withTestInstance` 内注册 SIGINT handler。

**修复方案:**
```typescript
export async function withTestInstance<T>(fn: (api: string) => Promise<T>): Promise<T> {
  const cleanup = () => {
    stopTestInstance();
    cleanupTestDir();
  };
  const sigintHandler = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', sigintHandler);
  try {
    await startTestInstance();
    return await fn(TEST_API);
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    cleanup();
  }
}
```

---

### 4. TUN 启动脚本 TOCTOU

- **文件**: `src/process.ts` `createTunLaunchScript`
- **问题**: 写 `runtime/launch-tun.sh` 后 `sudo` 执行，若 `MIHOMO_CLI_DIR` 指向共享目录存在竞态。
- **当前缓解**: `DIRS.runtime` 创建时 mode=0o700，仅 owner 可写。
- **建议**: 加注释说明安全假设；或改为直接 `sudo` 执行 mihomo binary（不通过中间脚本）。

---

## 中优先级（功能 Bug）

### 5. `sub web` 默认订阅错误

- **文件**: `src/commands/subscription.ts:357-358`
- **问题**: 使用 `subs[0]`（第一个添加的订阅）而非当前激活的订阅。
- **修复**:
```typescript
// 当前: target = subs[0];
// 修复:
target = getActiveSubscription() || subs[0];
```

---

### 6. `cmdClean` 重启强制 mixed 模式

- **文件**: `src/commands/start.ts` (auto-clean 路径)
- **问题**: 清理死节点后重启时硬编码 `'mixed'`，TUN 用户被静默降级。
- **修复**:
```typescript
const configInfo = getConfigInfo();
const currentMode = configInfo?.tun ? 'tun' : 'mixed';
// 使用 currentMode 替代硬编码 'mixed'
```

---

### 7. `updateInterval` 未校验正整数

- **文件**: `src/subscription.ts`
- **问题**: 服务器返回 `profile-update-interval: -1` 时 `parseInt` 得 -1（truthy），写入缓存后导致 `needsAutoUpdate` 永远为 true，每次 start 都重新下载。返回 `0` 时被 falsy 过滤（正确但语义不清晰）。
- **修复**:
```typescript
const updateInterval = updateIntervalHeader ? parseInt(updateIntervalHeader, 10) : null;
if (updateInterval !== null && updateInterval > 0) {
  cacheData.update_interval = updateInterval;
}
```

---

### 8. 首次 Ctrl+C 立即 exit — 双信号逻辑为死代码

- **文件**: `src/index.ts` SIGINT handler
- **问题**: 设 `exiting = true` 后立即 `process.exit(0)`，第二次信号永远不会被捕获。
- **修复**: 首次信号设标志 + 超时退出，二次信号强制退出：
```typescript
let exiting = false;
process.on('SIGINT', () => {
  if (exiting) {
    console.log('\n强制退出');
    process.exit(1);
  }
  exiting = true;
  console.log('\n正在退出...');
  setTimeout(() => process.exit(0), 3000); // 3s 后强制退出
});
```

---

### 9. `settingsCache` 引用泄露

- **文件**: `src/settings.ts`
- **问题**: `readSettings()` 返回缓存对象引用，`addSubscription` / `removeSubscription` 直接 mutate 该引用再调 `writeSettings`。若 `writeSettings` 失败（磁盘满），内存已改但磁盘未同步。
- **修复方案 A**: `writeSettings` 成功后再更新 `settingsCache`：
```typescript
export function addSubscription(name: string, url: string): void {
  const settings = readSettings();
  const newSettings = { ...settings, subscriptions: [...(settings.subscriptions || []), { name, url }] };
  writeSettings(newSettings); // 先写磁盘
  settingsCache = newSettings; // 成功后更新缓存
}
```
- **修复方案 B**: `readSettings()` 返回深拷贝（JSON.parse(JSON.stringify)），缓存不可被外部修改。

---

### 10. `maskUrl` 含逗号 URL 误切分

- **文件**: `src/settings.ts` `maskUrl` 函数
- **问题**: URL query string 含 `,` 时（如 `?nodes=us,hk`）被误认为多 URL 并切分，导致部分片段不是合法 URL 走 fallback 路径，可能暴露 token。
- **修复**: 移除 `maskUrl` 内的逗号切分逻辑，让调用者在明确知道是 multi-URL 时自行 split 后逐个 mask：
```typescript
export function maskUrl(url: string): string {
  // 移除: if (url.includes(',')) { ... }
  try {
    const u = new URL(url);
    // ... 正常 mask 逻辑
  } catch {
    // fallback
  }
}
```

---

### 11. `getKernelVersion` 无超时保护

- **文件**: `src/config.ts:286`
- **问题**: `execSync` 调用 mihomo binary 无 timeout，损坏的二进制可能永久阻塞。
- **修复**:
```typescript
const output = execSync(`"${PATHS.mihomoBinary}" -v 2>&1 || true`, {
  encoding: 'utf8',
  timeout: 5000,  // 5 秒超时
}).trim();
```
注：此处仍有 #1 的 shell 注入问题，两处一并修复时改用 `spawnSync`。

---

## 低优先级（健壮性/代码质量）

### 12. `child.pid` 断言非空未校验

- **文件**: `src/process.ts`
- **问题**: `child.pid as number` 类型断言，若进程表满 `child.pid` 为 `undefined`，则 PID 文件写入 `NaN`。
- **修复**:
```typescript
if (!child.pid) {
  throw new Error('进程启动失败：无法获取 PID');
}
savePid(child.pid);
```

---

### 13. `formatBytes` 未处理 `Infinity`

- **文件**: `src/utils.ts`
- **问题**: 输入 `Infinity` 时返回 `'Infinity TB'`。
- **修复**:
```typescript
if (Number.isNaN(num) || num < 0 || !Number.isFinite(num)) return '未知';
```

---

### 14. `displayWidth` 缺少 emoji 宽字符支持

- **文件**: `src/utils.ts`
- **问题**: 大部分 emoji（U+1F300–U+1FAFF）终端宽度为 2，但函数返回 1。
- **修复**: 增加范围判断：
```typescript
if (code >= 0x1F300 && code <= 0x1FAFF) return 2; // Emoji
if (code >= 0x2600 && code <= 0x27BF) return 2;   // Misc symbols
```

---

### 15. `ensureDirs` 冗余调用

- **文件**: `src/paths.ts`, `src/settings.ts`
- **问题**: 每次 `readSettings` / `writeSettings` / `readSubscriptionCache` / `writeSubscriptionCache` 都调用 `ensureDirs()`，累计 5+ 次 `existsSync` syscall。
- **修复**: 加模块级标记：
```typescript
let dirsEnsured = false;
export function ensureDirs(): void {
  if (dirsEnsured) return;
  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  dirsEnsured = true;
}
```

---

### 16. `isProxyValid` base64url 兼容

- **文件**: `src/utils.ts`
- **问题**: Shadowsocks 2022 密钥可能是 base64url 编码（`-` 和 `_` 替代 `+` 和 `/`），当前正则 `[A-Za-z0-9+/]+=*$` 会误判为无效。
- **修复**:
```typescript
if (!/^[A-Za-z0-9+/\-_]+=*$/.test(pw) || pw.length < 20) return false;
```

---

### 17. 下载内核无完整性校验

- **文件**: `src/kernel.ts`
- **问题**: 从 GitHub/镜像下载二进制后直接使用，未校验 SHA256。
- **建议**: mihomo releases 附带 checksums.txt，可下载并校验：
```typescript
// 下载 checksums.txt → 提取对应 asset 的 hash → 与本地文件比对
const expectedHash = extractHashFromChecksums(checksumsContent, asset.name);
const actualHash = crypto.createHash('sha256').update(fs.readFileSync(tempPath)).digest('hex');
if (actualHash !== expectedHash) throw new Error('校验失败，文件可能被篡改');
```

---

### 18. `findBinaryInDir` 无递归深度限制

- **文件**: `src/kernel.ts`
- **问题**: 恶意/异常归档中极深嵌套目录可导致栈溢出。
- **修复**:
```typescript
function findBinaryInDir(dir: string, maxDepth = 4): string | null {
  if (maxDepth <= 0) return null;
  // ...
  if (stat.isDirectory()) {
    const found = findBinaryInDir(fullPath, maxDepth - 1);
  }
}
```

---

### 19. `UI_URLS` / `DIRECTORY_TARGETS` 原型属性访问

- **文件**: `src/commands/ui.ts`, `src/commands/directory.ts`
- **问题**: 用户输入 `__proto__` 或 `constructor` 时，对象属性查找返回 `Object.prototype`（truthy），后续逻辑行为异常。
- **修复**:
```typescript
if (!Object.hasOwn(UI_URLS, uiName)) {
  // 显示错误
}
```

---

### 20. `readSettings` 损坏文件未备份

- **文件**: `src/settings.ts`
- **问题**: JSON 解析失败时提示"原文件已保留"，但下次 `writeSettings` 会覆盖为 `{}`。
- **修复**:
```typescript
} catch {
  const bakPath = PATHS.settingsFile + '.bak';
  fs.copyFileSync(PATHS.settingsFile, bakPath);
  console.warn(`警告: settings.json 格式损坏，已备份到 ${bakPath}，使用默认设置`);
  settingsCache = {};
  return settingsCache;
}
```

---

## 实施建议

| 批次 | 内容 | 涉及文件 | 预估工作量 |
|------|------|----------|-----------|
| 第一批 | #1 Shell 注入 + #2 原子写 + #3 进程泄漏 | process.ts, kernel.ts, config.ts, settings.ts, test-instance.ts | 中 |
| 第二批 | #5-#11 功能 Bug | subscription.ts, commands/subscription.ts, commands/start.ts, index.ts, settings.ts, config.ts | 中 |
| 第三批 | #12-#20 健壮性 | process.ts, utils.ts, paths.ts, kernel.ts, commands/ui.ts, commands/directory.ts, settings.ts | 小 |

## 验证清单

- [ ] `npm run typecheck` 通过
- [ ] `npm run check` (Biome lint + format) 通过
- [ ] `npm run build` 构建成功
- [ ] `mihomo start` / `mihomo tun` 正常启动
- [ ] `mihomo stop` 正常停止
- [ ] `mihomo sub test` + Ctrl+C 无残留进程
- [ ] `mihomo sub web` 打开正确订阅
- [ ] `mihomo kernel` 下载后内核可正常运行
- [ ] 模拟 settings.json 损坏 → 备份文件生成
