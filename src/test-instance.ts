import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { dumpYaml, parseYamlOrJson } from './config.js';
import { TEST_CONFIG } from './constants.js';
import { registerCleanup } from './lifecycle.js';
import { PATHS, rmrf, USER_DATA_DIR } from './paths.js';
import { readSubscriptionRawConfig } from './settings.js';
import { createHttpClient, isProcessRunning, isProxyValid, sleep, sleepSync } from './utils.js';

const TEST_DIR = path.join(USER_DATA_DIR, 'test');
const TEST_DIRS = {
  data: path.join(TEST_DIR, 'data'),
  runtime: path.join(TEST_DIR, 'runtime'),
};
const TEST_PATHS = {
  configFile: path.join(TEST_DIRS.runtime, 'config.yaml'),
  pidFile: path.join(TEST_DIRS.runtime, 'pid'),
  logFile: path.join(TEST_DIR, 'test.log'),
};

const TEST_API = `http://${TEST_CONFIG['external-controller']}`;

function ensureTestDirs(): void {
  for (const dir of Object.values(TEST_DIRS)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function cleanupTestDir(): void {
  rmrf(TEST_DIR);
}

function buildTestConfig(subName: string): void {
  ensureTestDirs();

  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new Error(`未找到订阅配置 "${subName}"`);
  }

  const parsed = parseYamlOrJson(rawContent, '订阅内容') as Record<string, unknown>;
  const proxies = ((parsed.proxies || []) as Array<{ name: string; [k: string]: unknown }>).filter(isProxyValid);

  if (proxies.length === 0) {
    throw new Error(`订阅 "${subName}" 没有有效节点`);
  }

  const nameCount = new Map<string, number>();
  for (const proxy of proxies) {
    const count = (nameCount.get(proxy.name) || 0) + 1;
    nameCount.set(proxy.name, count);
    if (count > 1) {
      proxy.name = `${proxy.name} #${count}`;
    }
  }

  const config: Record<string, unknown> = {
    ...TEST_CONFIG,
    proxies,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: proxies.map(p => p.name),
      },
    ],
    rules: ['MATCH,PROXY'],
  };

  const content = dumpYaml(config);
  fs.writeFileSync(TEST_PATHS.configFile, content, { mode: 0o600 });
}

async function startTestInstance(): Promise<void> {
  const binary = PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) throw new Error('未找到 mihomo 内核');

  stopTestInstance();

  const logFd = fs.openSync(TEST_PATHS.logFile, 'a');
  const child = spawn(binary, ['-d', TEST_DIRS.data, '-f', TEST_PATHS.configFile], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();

  const pid = child.pid as number;
  fs.writeFileSync(TEST_PATHS.pidFile, pid.toString(), { mode: 0o600 });

  const client = createHttpClient({ timeout: 2000 });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (!isProcessRunning(pid)) break;
    try {
      await client.get(`${TEST_API}/version`);
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }

  if (!isProcessRunning(pid)) {
    let errorDetail = '';
    try {
      errorDetail = fs.readFileSync(TEST_PATHS.logFile, 'utf8').slice(-1000);
    } catch {
      /* ignore */
    }
    throw new Error(`测试实例启动失败${errorDetail ? `\n${errorDetail}` : ''}`);
  }

  if (!ready) {
    throw new Error('测试实例启动超时，API 未响应');
  }
}

function stopTestInstance(): void {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(TEST_PATHS.pidFile, 'utf8').trim(), 10);
  } catch {
    return;
  }
  if (pid > 0 && isProcessRunning(pid)) {
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 20; i++) {
      if (!isProcessRunning(pid)) break;
      sleepSync(100);
    }
  }
  try {
    fs.unlinkSync(TEST_PATHS.pidFile);
  } catch {
    /* ignore */
  }
}

export async function withTestInstance<T>(subName: string, fn: (apiBase: string) => Promise<T>): Promise<T> {
  cleanupTestDir();
  buildTestConfig(subName);
  // 注册到全局清理表：即使用户 Ctrl+C 触发 process.exit（跳过 finally），
  // 信号处理器也会同步执行这里的清理，避免端口 27890 的测试实例残留。
  const unregister = registerCleanup(() => {
    stopTestInstance();
    cleanupTestDir();
  });
  try {
    await startTestInstance();
    return await fn(TEST_API);
  } finally {
    unregister();
    stopTestInstance();
    cleanupTestDir();
  }
}
