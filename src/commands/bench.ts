import {
  buildMergedBenchConfig,
  cleanupBenchDir,
  computeSourceResult,
  downloadAllSources,
  startBenchInstance,
  stopBenchInstance,
  testBenchProxies,
} from '../bench.js';
import { hasKernel } from '../config.js';
import { BENCH_CONFIG, getFreeSubscriptionSources } from '../constants.js';
import type { BenchSourceResult } from '../types.js';
import { colors, displayWidth, getNonFlagArg, parseIntArg } from '../utils.js';
import { formatTestSummary } from './subscription.js';

function printRanking(results: BenchSourceResult[], sourceOrder: Map<string, number>): void {
  const valid = results
    .filter(r => r.downloadOk && r.alive > 0)
    .sort((a, b) => {
      const rateA = a.alive / a.totalProxies;
      const rateB = b.alive / b.totalProxies;
      if (Math.abs(rateA - rateB) > 0.1) return rateB - rateA;
      return a.medianDelay - b.medianDelay;
    });

  if (valid.length === 0) {
    console.log(colors.yellow('没有可用的订阅源'));
    return;
  }

  console.log(colors.cyan('排名:'));
  console.log('');

  const namedResults = valid.map(r => {
    const idx = sourceOrder.get(r.name) ?? 0;
    return { ...r, displayName: `${String(idx + 1).padStart(2, '0')}-${r.name}` };
  });

  const nameWidth = Math.max(12, ...namedResults.map(r => r.displayName.length));

  const h = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)));
  console.log(
    `  ${'#'.padStart(3)}  ${h('名称', nameWidth)}  ${h('存活率', 8)}  ${h('存活', 6)}  ${h('总数', 6)}  ${h('分组', 6)}  ${h('中位', 7)}  ${h('平均', 7)}`,
  );
  console.log(
    `  ${'─'.repeat(3)}  ${'─'.repeat(nameWidth)}  ${'─'.repeat(8)}  ${'─'.repeat(6)}  ${'─'.repeat(6)}  ${'─'.repeat(6)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`,
  );

  for (let i = 0; i < namedResults.length; i++) {
    const r = namedResults[i];
    const rate = ((r.alive / r.totalProxies) * 100).toFixed(1);
    const rateColor = r.alive / r.totalProxies > 0.3 ? colors.green : colors.yellow;
    const groups = r.proxyGroups > 0 ? String(r.proxyGroups) : '-';
    console.log(
      `  ${String(i + 1).padStart(3)}  ${r.displayName.padEnd(nameWidth)}  ${rateColor(h(`${rate}%`, 8))}  ${String(r.alive).padEnd(6)}  ${String(r.totalProxies).padEnd(6)}  ${groups.padEnd(6)}  ${h(`${r.medianDelay}ms`, 7)}  ${h(`${r.avgDelay}ms`, 7)}`,
    );
  }

  console.log('');

  const failed = results.filter(r => !r.downloadOk);
  const noAlive = results.filter(r => r.downloadOk && r.alive === 0);
  if (failed.length > 0) {
    const names = failed.map(r => `${String((sourceOrder.get(r.name) ?? 0) + 1).padStart(2, '0')}-${r.name}`);
    console.log(colors.gray(`下载失败: ${names.join(', ')}`));
  }
  if (noAlive.length > 0) {
    const names = noAlive.map(r => `${String((sourceOrder.get(r.name) ?? 0) + 1).padStart(2, '0')}-${r.name}`);
    console.log(colors.gray(`无存活节点: ${names.join(', ')}`));
  }
}

export async function cmdBench(args: string[]): Promise<void> {
  if (!hasKernel()) {
    console.error('错误: 未找到内核，请运行 "mihomo kernel"');
    process.exit(1);
  }

  const timeout = parseIntArg(args, '-t', '--timeout', 1500);
  const concurrency = parseIntArg(args, '-j', '--concurrency', 100);
  const nameFilter = getNonFlagArg(args, 1);

  const allSources = getFreeSubscriptionSources();
  const sourceOrder = new Map(allSources.map((s, i) => [s.name, i]));
  let sources = allSources;
  if (nameFilter) {
    const lower = nameFilter.toLowerCase();
    sources = sources.filter(s => s.name.toLowerCase().includes(lower));
    if (sources.length === 0) {
      console.error(`错误: 未找到匹配 "${nameFilter}" 的订阅源`);
      console.log('\n可用源:');
      for (const s of allSources) console.log(`  ${s.name}`);
      process.exit(1);
    }
  }

  console.log(colors.cyan(`基准测试 ${sources.length} 个免费订阅源`));
  console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
  console.log('');

  try {
    console.log(colors.cyan('下载订阅...'));
    const downloaded = await downloadAllSources(sources, (name, ok, count, groups, error) => {
      const idx = String((sourceOrder.get(name) ?? 0) + 1).padStart(2, '0');
      if (ok) {
        const groupsInfo = groups > 0 ? ` ${groups}组` : '';
        console.log(`  ${colors.green('✓')} ${idx}-${name}: ${count} 个节点${groupsInfo}`);
      } else {
        console.log(`  ${colors.red('✗')} ${idx}-${name}: ${colors.gray(error || '失败')}`);
      }
    });

    const allProxies = downloaded.flatMap(d => d.proxies);
    const successSources = downloaded.filter(d => d.proxies.length > 0);

    if (allProxies.length === 0) {
      console.log('');
      console.log(colors.red('所有订阅源下载失败或无节点'));
      return;
    }

    console.log('');
    console.log(`共 ${allProxies.length} 个节点，来自 ${successSources.length} 个源`);
    console.log('');

    const filtered = buildMergedBenchConfig(allProxies);
    if (filtered > 0) {
      console.log(colors.gray(`过滤 ${filtered} 个无效节点，剩余 ${allProxies.length} 个`));
    }

    const survivingSet = new Set(allProxies);
    for (const d of downloaded) {
      d.proxies = d.proxies.filter(p => survivingSet.has(p));
    }

    const benchPort = BENCH_CONFIG['mixed-port'];
    const benchApi = BENCH_CONFIG['external-controller'];
    console.log(colors.cyan('启动测试实例...'));
    await startBenchInstance();
    console.log(`${colors.green('已启动')} (端口 ${benchPort}/${(benchApi as string).split(':')[1]})`);
    console.log('');

    console.log(colors.cyan('测试节点延迟...'));
    const allNames = allProxies.map(p => p.name);
    const testResults = await testBenchProxies(allNames, {
      timeout,
      concurrency,
      onBatch: (batch, total, alive, tested, median) => {
        const pct = ((tested / allNames.length) * 100).toFixed(0);
        process.stdout.write(`\r  批次 ${batch}/${total}  进度 ${pct}%  已测 ${tested}  存活 ${colors.green(String(alive))}  中位延迟 ${median}ms`);
      },
    });
    process.stdout.write(`\r${' '.repeat(80)}\r`);

    const totalAlive = testResults.filter(r => r.delay !== null).length;
    const summary = { alive: totalAlive, dead: testResults.length - totalAlive, total: testResults.length };
    console.log(formatTestSummary(summary));
    console.log('');

    const resultsByName = new Map(testResults.map(r => [r.name, r]));
    const results: BenchSourceResult[] = downloaded.map(source => computeSourceResult(source, resultsByName));

    printRanking(results, sourceOrder);
  } finally {
    stopBenchInstance();
    cleanupBenchDir();
  }
}
