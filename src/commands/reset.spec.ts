import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RESET_PRESERVED_ON_BARE, RESET_TARGETS, WRITES_SETTINGS_ON_AFTER } from './reset.js';

describe('RESET_TARGETS 执行顺序', () => {
  const indexOf = (id: string): number => RESET_TARGETS.findIndex(t => t.id === id);

  // 数组顺序就是执行顺序（resolveResetTargets 按它排序，使结果与用户输入顺序无关）。
  // 带 onAfter: writeSettings 的目标若排在 settings 之后，会把刚删掉的 settings.json
  // 重建出来，于是 `reset --full` 报「已重置: 设置」却留下一个文件。
  //
  // **按清单遍历，不点名单个目标**：此前只断言了 subs，同族的 overwrites 带着
  // 一模一样的缺陷躺在盲区里（它排在 settings 之后，重建出的
  // `{"overwrite_enabled": false}` 还会把覆写静默关掉）。
  it('所有写 settings 的 onAfter 目标都排在 settings 之前', () => {
    for (const id of WRITES_SETTINGS_ON_AFTER) {
      const target = RESET_TARGETS.find(t => t.id === id);
      assert.ok(target, `WRITES_SETTINGS_ON_AFTER 里的 "${id}" 不存在于 RESET_TARGETS（id 改名时漏改？）`);
      assert.ok(target?.onAfter, `${id} 应有 onAfter（否则不该登记在 WRITES_SETTINGS_ON_AFTER 里）`);
      assert.ok(indexOf(id) < indexOf('settings'), `${id}(${indexOf(id)}) 必须早于 settings(${indexOf('settings')})，否则会重建刚删掉的 settings.json`);
    }
  });

  it('目标 id 与别名均无重复', () => {
    const ids = RESET_TARGETS.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, `id 重复: ${ids.join(', ')}`);
    const aliases = RESET_TARGETS.flatMap(t => t.aliases);
    assert.equal(new Set(aliases).size, aliases.length, `别名重复: ${aliases.join(', ')}`);
  });
});

describe('RESET_PRESERVED_ON_BARE：裸 reset 保留的用户资产', () => {
  // 此前这份清单是内联的字符串数组。target id 改名（daemon → service）时若漏改，
  // 裸 `mihomo reset` 会从「保留服务安装」静默变成「卸载服务」，且不报任何错。
  // 故清单必须是具名常量，且每一项都要能对上真实存在的 target。
  it('每一项都对应真实存在的 target id', () => {
    const ids = new Set(RESET_TARGETS.map(t => t.id));
    for (const preserved of RESET_PRESERVED_ON_BARE) {
      assert.ok(ids.has(preserved), `保留清单里的 "${preserved}" 不存在于 RESET_TARGETS（id 改名时漏改？）`);
    }
  });

  it('service 在保留清单中：裸 reset 不得卸载用户的服务安装', () => {
    assert.ok(RESET_PRESERVED_ON_BARE.includes('service'));
  });

  it('运行数据类目标不在保留清单中（裸 reset 的本职就是清它们）', () => {
    for (const id of ['subs', 'logs', 'data', 'runtime']) {
      assert.ok(!RESET_PRESERVED_ON_BARE.includes(id as never), `${id} 不应被保留`);
    }
  });
});

describe('reset --full 真的把 settings.json 删干净', () => {
  // 端到端断言，**不依赖 WRITES_SETTINGS_ON_AFTER 清单的正确性**：清单漏登记
  // （新增了写 settings 的 onAfter 却忘了补进去）时，上面那条顺序断言会空过，
  // 而这条仍会失败。判据是磁盘上的最终状态，不是注册表的形状。
  //
  // 隔离：MIHOMO_CLI_DIR 指向 tmpdir，子进程跑真实入口，绝不碰 ~/.mihomo-cli。
  // reset --full 含 service target，但未安装服务时 checkEmpty 会让它成为 no-op，
  // 不触碰 launchd（测试机上不装任何服务）。
  it('reset --full 后 settings.json 不存在（不得被 onAfter 重建）', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-full-'));
    try {
      // 前提断言：隔离生效。指向的必须是 tmpdir，而不是用户真实数据目录
      assert.ok(dataDir.startsWith(os.tmpdir()), '测试数据目录必须在 tmpdir 内，否则会删掉用户真实配置');

      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ controller_secret: 'SECRET', overwrite_enabled: true }));
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');

      const code = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), 'reset', '--full', '-y'], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: dataDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });
      assert.equal(code, 0, 'reset --full 应正常退出');

      const settingsPath = path.join(dataDir, 'settings.json');
      assert.equal(
        fs.existsSync(settingsPath),
        false,
        `reset --full 报「已重置: 设置」后 settings.json 仍存在，内容: ${fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : ''}`,
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reset --full 后覆写回到默认「启用」，不被静默持久化为禁用', async () => {
    // overwrites 的 onAfter 写 overwrite_enabled:false。它若在 settings 之后跑，
    // 重建出的 settings.json 会把覆写关着——而全新数据目录的默认是启用。
    // 用户重置后重新放一份 overwrite.yaml，覆写静默不生效且毫无线索。
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-ow-'));
    try {
      assert.ok(dataDir.startsWith(os.tmpdir()), '测试数据目录必须在 tmpdir 内');
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');

      await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), 'reset', '--full', '-y'], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: dataDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });

      // 重置后重新放覆写文件，问 isOverwriteEnabled 的实际结论
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');
      const script = [
        `import assert from 'node:assert/strict';`,
        `import { isOverwriteEnabled } from ${JSON.stringify(path.resolve('src/overwrite.ts'))};`,
        `assert.equal(isOverwriteEnabled(), true, 'reset 后覆写应回到默认启用，实际被持久化成了禁用');`,
      ].join('\n');
      const code = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: dataDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });
      assert.equal(code, 0, 'reset --full 之后覆写不该处于禁用状态（子进程断言失败）');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
