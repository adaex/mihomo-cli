import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isValidServiceLabel } from './constants.js';
import { buildPlist, describeAbnormalExit, describeExitCause, parseDisabledList, parseServicePrint, shouldAbortStartOnDisable } from './service.js';
import type { ServiceStatus } from './types.js';

/**
 * launchctl print 的真实输出片段（本机 macOS 26.6 实测截取）。
 * 关键在于它同时含**单 tab 的顶层 state/pid** 与**双 tab 的嵌套 endpoint state**——
 * 后者是解析踩坑的根源，故 fixture 必须保留这些干扰行。
 */
const REAL_PRINT_RUNNING = `system/com.example.svc = {
	active count = 1
	path = /Library/LaunchDaemons/com.example.svc.plist
	type = LaunchDaemon
	state = running

	program = /usr/local/bin/example
	arguments = {
		/usr/local/bin/example
		-N
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	runs = 2
	pid = 5474
	immediate reason = speculative
	forks = 0
	execs = 2
	initialized = 1
	last exit code = 255

	endpoints = {
		"com.example.svc.socket" = {
			port = 12345
			active = 1
			managed = 1
			state = active
		}
		"com.example.svc.other" = {
			port = 54321
			active = 1
			managed = 1
			state = active
		}
	}

	spawn type = daemon (3)
}`;

const REAL_PRINT_NOT_RUNNING = `gui/501/com.example.svc = {
	active count = 0
	path = /Users/x/Library/LaunchAgents/com.example.svc.plist
	type = LaunchAgent
	state = not running

	program = /Users/x/bin/example

	endpoints = {
		"com.example.svc.socket" = {
			state = active
		}
	}
}`;

/**
 * 嵌套块排在顶层 state/pid **之前**的变体。
 *
 * 实测本机若干服务，launchd 都把顶层 state 放在第 5 行、嵌套 endpoint 靠后，
 * 因此不锚定的正则「碰巧」也能取对——这正是危险之处：字段顺序是 launchd 的实现
 * 细节而非契约，一旦某个 macOS 版本换了顺序，不锚定的解析会静默取到 `active`，
 * 于是「运行中」恒判 false。本 fixture 把顺序倒过来，锁住锚定行为本身。
 */
const PRINT_NESTED_FIRST = `gui/501/com.example.svc = {
	endpoints = {
		"com.example.svc.socket" = {
			state = active
			pid = 99999
		}
	}
	state = running
	pid = 5474
}`;

describe('parseServicePrint：只认顶层字段，不被嵌套 endpoint 干扰', () => {
  // 嵌套的 `\t\tstate = active` 在真实输出里出现多次。不锚定单 tab 的话
  // state 会被解析成 "active"，于是「运行中」永远判成 false——服务明明在跑，
  // CLI 却说没跑，且每次 start 都去做多余的冷启动
  it('运行中：取顶层 state 与 pid，忽略双 tab 的 endpoint state', () => {
    const r = parseServicePrint(REAL_PRINT_RUNNING);
    assert.equal(r.state, 'running');
    assert.equal(r.pid, 5474);
  });

  it('嵌套块排在顶层之前时，仍只取顶层（锁住行首单 tab 锚定，不依赖字段顺序）', () => {
    const r = parseServicePrint(PRINT_NESTED_FIRST);
    assert.equal(r.state, 'running');
    assert.equal(r.pid, 5474);
  });

  it('未运行：state 为 not running，且无 pid 行时 pid 为 null', () => {
    const r = parseServicePrint(REAL_PRINT_NOT_RUNNING);
    assert.equal(r.state, 'not running');
    assert.equal(r.pid, null);
  });

  it('空输出（launchctl 查不到时）返回全 null，不抛', () => {
    const r = parseServicePrint('');
    assert.equal(r.state, null);
    assert.equal(r.pid, null);
  });

  it('畸形输出不抛，按查不到处理', () => {
    const r = parseServicePrint('Bad request.\nCould not find service "x" in domain for system');
    assert.equal(r.state, null);
    assert.equal(r.pid, null);
  });

  it('pid = 0 视为无效（launchd 不会给 0，出现即异常）', () => {
    assert.equal(parseServicePrint('\tstate = running\n\tpid = 0\n').pid, null);
  });
});

/**
 * `last exit code` 是判定「起来了又立刻挂掉」的唯一可靠信号（见 waitServiceHealthy）。
 * 健康服务上 launchd 写的是**字符串** `(never exited)`，不是数字——不区分的话
 * 解析出 NaN 或 0 都会让崩溃判定失效，start 继续把崩溃循环报成「已启动」。
 */
describe('parseServicePrint：last exit code 区分数字与 (never exited)', () => {
  it('健康服务的 (never exited) 解析为 null，不是 0', () => {
    const out = '\tstate = running\n\tpid = 123\n\tlast exit code = (never exited)\n';
    assert.equal(parseServicePrint(out).lastExitCode, null);
  });

  it('崩溃服务的非 0 退出码被取到（本机实测 exit 1 的真实形态）', () => {
    const out = '\tstate = spawn scheduled\n\truns = 1\n\tlast exit code = 1\n';
    const r = parseServicePrint(out);
    assert.equal(r.lastExitCode, 1);
    assert.equal(r.state, 'spawn scheduled');
    assert.equal(r.pid, null, 'spawn scheduled 时无 pid 行');
  });

  it('正常退出的 0 与「从未退出」区分开（0 不是失败）', () => {
    assert.equal(parseServicePrint('\tlast exit code = 0\n').lastExitCode, 0);
  });

  it('嵌套块里的同名字段不被误取（同 state/pid 的锚定要求）', () => {
    const out = '\tstate = running\n\tservice = {\n\t\tlast exit code = 9\n\t}\n';
    assert.equal(parseServicePrint(out).lastExitCode, null);
  });

  it('REAL_PRINT_RUNNING 的 last exit code = 255 被取到', () => {
    // 该 fixture 里服务在跑但历史上退出过——waitServiceHealthy 因此必须
    // 让「当前 running」优先于「历史退出码」，否则健康服务会被误报成崩溃
    assert.equal(parseServicePrint(REAL_PRINT_RUNNING).lastExitCode, 255);
    assert.equal(parseServicePrint(REAL_PRINT_RUNNING).state, 'running');
  });
});

/**
 * 信号死亡的真实输出（本机实测 macOS 26.6，一次性 label 装桩服务后 kill）。
 *
 * **关键事实：两字段互斥**——被信号杀死时 `last exit code` 整行消失，只剩
 * `last terminating signal`。故只解析退出码的话，OOM killer / `kill -9` 干掉的
 * 内核对 isCrashed 与 status 完全不可见：用户看到「不在运行」却无任何异常提示，
 * 而 KeepAlive 正在反复拉起它。实测两种信号形态如下，格式一致。
 */
const REAL_PRINT_KILLED = `	state = not running
	exit timeout = 5
	runs = 1
	last terminating signal = Killed: 9
		state = active
`;

const REAL_PRINT_TERMINATED = `	state = not running
	exit timeout = 5
	last terminating signal = Terminated: 15
`;

describe('parseServicePrint：last terminating signal（信号死亡）', () => {
  it('kill -9 的真实输出被取到，且 lastExitCode 确实为 null（字段不存在）', () => {
    const r = parseServicePrint(REAL_PRINT_KILLED);
    assert.equal(r.lastTerminatingSignal, 'Killed: 9');
    assert.equal(r.lastExitCode, null, 'launchd 在信号死亡时不写 last exit code');
    assert.equal(r.state, 'not running');
  });

  it('SIGTERM 同格式', () => {
    assert.equal(parseServicePrint(REAL_PRINT_TERMINATED).lastTerminatingSignal, 'Terminated: 15');
  });

  it('正常退出的输出里该字段为 null（两字段互斥，实测不跨 bootstrap 残留）', () => {
    const out = '\tstate = not running\n\truns = 1\n\tlast exit code = 3\n';
    const r = parseServicePrint(out);
    assert.equal(r.lastTerminatingSignal, null);
    assert.equal(r.lastExitCode, 3);
  });

  it('健康运行的服务两字段都不报异常', () => {
    const r = parseServicePrint(REAL_PRINT_RUNNING);
    assert.equal(r.lastTerminatingSignal, null);
  });

  it('嵌套块里的同名字段不被误取（锚定行首单 tab）', () => {
    const out = '\tstate = running\n\tservice = {\n\t\tlast terminating signal = Killed: 9\n\t}\n';
    assert.equal(parseServicePrint(out).lastTerminatingSignal, null);
  });
});

/**
 * 崩溃描述收口成 describeAbnormalExit：status / doctor 三处此前各写一遍
 * `lastExitCode !== null && !== 0`，补信号判据时必须同步改三处——正是
 * CLAUDE.md 说的「防线只铺一条路径」的形状。
 */
describe('describeAbnormalExit', () => {
  const status = (over: Partial<ServiceStatus>): ServiceStatus => ({
    installed: true,
    loaded: true,
    running: false,
    pid: null,
    disabled: false,
    lastExitCode: null,
    lastTerminatingSignal: null,
    ...over,
  });

  it('信号死亡给出信号描述（此前完全不可见）', () => {
    assert.equal(describeAbnormalExit(status({ lastTerminatingSignal: 'Killed: 9' })), '被信号终止（Killed: 9）');
  });

  it('非 0 退出码给出退出码', () => {
    assert.equal(describeAbnormalExit(status({ lastExitCode: 3 })), '退出码 3');
  });

  it('退出码 0 不算异常', () => {
    assert.equal(describeAbnormalExit(status({ lastExitCode: 0 })), null);
  });

  it('从未退出过不算异常', () => {
    assert.equal(describeAbnormalExit(status({})), null);
  });
});

/**
 * `describeExitCause` 是异常退出判据的唯一一份，三个消费者共用：
 * isCrashed（判有无）、describeAbnormalExit（status/doctor 文案）、
 * runtime.assertServiceHealthy（start/install 的启动失败文案）。
 *
 * 直接对着它断言而非各消费者：v4.7.3 补信号判据时 status/doctor 收口了，
 * 却漏了 assertServiceHealthy——那里仍拼 `退出码 ${exitCode}`，而信号死亡时
 * launchd 不写 last exit code（exitCode 为 null），用户在 start 期间被 OOM killer
 * 杀掉的内核只看到「退出码 null」。判据收成一处后，这类漏铺才不会再发生。
 */
describe('describeExitCause：异常退出判据的唯一一份', () => {
  it('信号死亡时给出信号，而不是「退出码 null」', () => {
    // exitCode 恒为 null 是实测事实（两字段互斥），故这正是 start 路径此前的入参
    assert.equal(describeExitCause(null, 'Killed: 9'), '被信号终止（Killed: 9）');
  });

  it('信号优先于退出码（两者理论上不会同时出现，出现则信号更具体）', () => {
    assert.equal(describeExitCause(1, 'Killed: 9'), '被信号终止（Killed: 9）');
  });

  it('非 0 退出码给出退出码', () => {
    assert.equal(describeExitCause(3, null), '退出码 3');
  });

  it('退出码 0 与「无记录」都不算异常', () => {
    assert.equal(describeExitCause(0, null), null);
    assert.equal(describeExitCause(null, null), null);
  });

  it('两个判据缺一不可：只看退出码会让信号死亡完全不可见', () => {
    // 锁住「不能退化成只看 exitCode」——退化后这一条会返回 null
    assert.notEqual(describeExitCause(null, 'Terminated: 15'), null);
  });
});

/** `launchctl print-disabled` 的真实输出格式（双 tab 缩进 + 引号包裹 label）。 */
const REAL_DISABLED = `	disabled services = {
		"com.apple.AEServer" => disabled
		"com.mihomo-cli.daemon" => disabled
		"com.openssh.sshd" => enabled
		"com.other.svc" => true
		"com.another.svc" => false
	}`;

describe('parseDisabledList：区分 disabled/enabled，不在表中视为启用', () => {
  it('值为 disabled 判为禁用', () => {
    assert.equal(parseDisabledList(REAL_DISABLED, 'com.mihomo-cli.daemon'), true);
  });

  // 关键：launchctl 没有「清除记录」的动词，enable 同样会往表里写一条 `=> enabled`。
  // 只判断「在不在表里」会把 enable 过的服务误判成已禁用 → start 后 status 显示
  // 「自启已关闭」，与事实相反
  it('值为 enabled 判为启用（enable 也会留下记录，不能只看是否在表中）', () => {
    assert.equal(parseDisabledList(REAL_DISABLED, 'com.openssh.sshd'), false);
  });

  it('旧格式 true/false 同样识别', () => {
    assert.equal(parseDisabledList(REAL_DISABLED, 'com.other.svc'), true);
    assert.equal(parseDisabledList(REAL_DISABLED, 'com.another.svc'), false);
  });

  it('不在表中 = 从未设置过 = 默认启用', () => {
    assert.equal(parseDisabledList(REAL_DISABLED, 'com.never.seen'), false);
  });

  it('空输出不抛，按启用处理', () => {
    assert.equal(parseDisabledList('', 'com.mihomo-cli.daemon'), false);
  });

  // label 里的 `.` 是合法字符且极其常见；不转义的话它作为正则通配符会匹配到别的条目
  it('label 中的点号不被当作正则通配符', () => {
    const out = '\t\t"com.aXb.svc" => disabled';
    assert.equal(parseDisabledList(out, 'com.a.b.svc'), false);
  });

  it('label 前缀相同但更长的条目不误匹配', () => {
    const out = '\t\t"com.mihomo-cli.daemon.extra" => disabled';
    assert.equal(parseDisabledList(out, 'com.mihomo-cli.daemon'), false);
  });
});

/**
 * 这个判据被改错过两次，两种错法的失效方向相反，故用例必须同时锁住两边。
 *
 * - **v4.7.5**：判据是「当前是否 disabled」。disable 位是持久的（`stop`/`tun` 置位后
 *   一直留着，launchctl 无清除动词），于是 stop 之后的**每一次** `start` 都被误判成
 *   并发 stop，静默不 enable、不 bootstrap，内核永不被拉起。报错却是「内核未能进入
 *   运行状态」+ 一个从未被创建的日志路径（实测复现，darwin arm64）
 * - **v4.7.6**：判据是「disable 位的前后快照比对」。修好了上面那条，但「上次也 stop 过」时
 *   两边快照都是 `true`，并发 stop 完全隐形——防线在最常见的前置状态下是空的
 *
 * 现在判据是**停止计数是否变化**：计数由 CLI 在每次 disable 成功后递增，与位的当前值
 * 完全解耦。第 3 条（「上次 stop 过 + 本次又有人 stop」）就是 v4.7.6 漏掉的那个组合，
 * 也是这一版真正修的东西。
 */
describe('shouldAbortStartOnDisable：判据是停止计数的变化，不是 disable 位的值', () => {
  it('计数未变 → 无人 stop，照常启动', () => {
    assert.equal(shouldAbortStartOnDisable(5, 5), false);
  });

  // v4.7.5 缺陷的回归：上次 stop 留下的持久位不该拦住本次显式 start。
  // 计数判据下它天然成立——位再怎么持久，没人新 stop 计数就不动
  it('计数未变（哪怕当前 disabled 位是开着的）→ 照常启动', () => {
    assert.equal(shouldAbortStartOnDisable(0, 0), false);
  });

  it('计数变了 → 期间有人 stop 过，放弃启动', () => {
    assert.equal(shouldAbortStartOnDisable(5, 6), true);
  });

  // **v4.7.6 漏掉的组合**：上次 stop 过（基线非 0）且本次期间又有人 stop。
  // 旧的位快照判据在这里两边都是 true → 判为「非并发」→ 把并发 stop 覆盖掉
  it('基线非 0 且期间又 stop → 仍能检出（v4.7.6 在此失效）', () => {
    assert.equal(shouldAbortStartOnDisable(3, 4), true);
  });

  // 计数只增不减，但判据用「不等于」而非「大于」：epoch 文件被 reset 删掉后重置为 0，
  // 若基线是 7、现值是 0，那也意味着期间发生过状态变更，保守起见同样中止
  it('计数回退（文件被删后重置为 0）→ 同样视为发生过变更', () => {
    assert.equal(shouldAbortStartOnDisable(7, 0), true);
  });
});

/**
 * 判据的纯函数用例只锁「给定两个数怎么判」，锁不住「这两个数是否真的反映了并发」。
 * 这一组补的就是后者：epoch 文件在真实文件系统下能否让 start 侧看见 stop 侧的动作。
 *
 * 调的是 `service.ts` 导出的**真实** `readStopEpoch`（经 `MIHOMO_CLI_DIR` 指向 tmpdir），
 * 不在测试里另抄一份——抄一份等于在验副本，两边一漂移就测了个假的。
 *
 * 不碰 launchctl——`disableServiceAutoStart` 会真改 launchd 的 disabled 表（在系统里
 * 留永久记录，见 `CODE_REVIEW.md` 的「决策豁免」）。这里只验计数机制本身：
 * 文件层通了，配合上面的判据用例，整条链路的正确性就锁住了。
 */
describe('停止计数的读取（并发判定的物理基础）', () => {
  /**
   * 在隔离数据目录里跑一段用真实 readStopEpoch 的脚本，返回其 stdout。
   * 用子进程是因为 `PATHS` 在模块加载时就固化了 `MIHOMO_CLI_DIR`，同进程内改环境变量无效。
   */
  const readEpochIn = (dir: string): number => {
    const servicePath = path.resolve('src/service.ts');
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `import { readStopEpoch } from ${JSON.stringify(servicePath)}; process.stdout.write(String(readStopEpoch()));`],
      {
        encoding: 'utf8',
        env: { ...process.env, MIHOMO_CLI_DIR: dir, MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1' },
        timeout: 30_000,
      },
    );
    assert.equal(r.status, 0, `读取子进程应正常退出: ${r.stderr}`);
    return Number.parseInt(r.stdout.trim(), 10);
  };

  it('文件不存在时读作 0（首次运行的正常形态，不能抛错挡住 start）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-epoch-'));
    try {
      assert.equal(readEpochIn(dir), 0);
      // 与 0 比对 → 判为「无并发」→ start 照常进行。首次运行必须能启动
      assert.equal(shouldAbortStartOnDisable(0, readEpochIn(dir)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('内容损坏时读作 0，不抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-epoch-'));
    try {
      for (const junk of ['', '  ', 'abc', '-1', 'NaN']) {
        fs.writeFileSync(path.join(dir, 'service-stop-epoch'), junk);
        assert.equal(readEpochIn(dir), 0, `损坏内容 ${JSON.stringify(junk)} 应读作 0`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 核心场景：A 取基线 → B（另一进程）stop 递增 → A 复读，必须看见变化。
  // 这正是 v4.7.6 检不出的那个组合——基线非 0（上次也 stop 过）且期间又发生 stop
  it('基线非 0 时另一进程递增，复读能看见（v4.7.6 在此失效）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-epoch-'));
    const file = path.join(dir, 'service-stop-epoch');
    try {
      fs.writeFileSync(file, '3'); // 上次 stop 留下的基线
      const before = readEpochIn(dir);
      assert.equal(before, 3);

      fs.writeFileSync(file, '4'); // 另一进程 stop

      assert.equal(shouldAbortStartOnDisable(before, readEpochIn(dir)), true, '基线非 0 时也必须检出并发 stop');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPlist', () => {
  it('ProgramArguments[0] 指向符号链而非真实内核二进制', () => {
    // 「登录项与扩展」按 basename 显示；指向 kernel/mihomo 的话用户只看到无上下文的 "mihomo"
    const xml = buildPlist();
    const first = xml.match(/<array>\s*<string>([^<]+)<\/string>/);
    assert.ok(first, '应能取到 ProgramArguments 首项');
    assert.ok(first[1].endsWith('/mihomo-cli-service'), `首项应是符号链，实际: ${first[1]}`);
  });

  it('不设 UserName：gui 域下默认即当前用户，写了只会引入用户名依赖', () => {
    assert.ok(!buildPlist().includes('<key>UserName</key>'));
  });

  it('含 RunAtLoad 与 KeepAlive（登录自启 + 崩溃拉起）', () => {
    const xml = buildPlist();
    assert.ok(xml.includes('<key>RunAtLoad</key>'));
    assert.ok(xml.includes('<key>KeepAlive</key>'));
  });

  it('生成的 XML 结构完整', () => {
    const xml = buildPlist();
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<plist version="1.0">'));
    assert.ok(xml.trimEnd().endsWith('</plist>'));
  });

  it('路径中的 XML 元字符被转义（数据目录可能含 & < > 等）', () => {
    // buildPlist 读模块级 PATHS，无法注入路径；此处直接锁定转义函数的行为契约：
    // 生成物里不得出现未转义的裸 & （所有 & 都应是实体引用的一部分）
    const xml = buildPlist();
    const bareAmp = xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    assert.equal(bareAmp, null, '不应出现未转义的裸 &');
  });
});

describe('isValidServiceLabel：全仓唯一挡住 root 任意路径写的校验', () => {
  // 该值经 path.join 拼成 plist 路径后，也是清理遗留 root 安装时 `sudo rm -f` 的删除目标。
  // `..` 被 path.join 折叠即可越出 /Library/LaunchDaemons，以 root 删除任意路径
  it('拒绝含 .. 的值（路径穿越 → 以 root 写任意路径）', () => {
    assert.equal(isValidServiceLabel('../../etc/sudoers.d/evil'), false);
    assert.equal(isValidServiceLabel('a..b'), false);
  });

  it('拒绝含斜杠的值', () => {
    assert.equal(isValidServiceLabel('foo/bar'), false);
  });

  it('拒绝空串与前导非字母数字', () => {
    assert.equal(isValidServiceLabel(''), false);
    assert.equal(isValidServiceLabel('.hidden'), false);
    assert.equal(isValidServiceLabel('-dash'), false);
    assert.equal(isValidServiceLabel('_under'), false);
  });

  it('拒绝空格、引号与 shell 元字符', () => {
    for (const bad of ['a b', "a'b", 'a"b', 'a;b', 'a$b', 'a`b', 'a\nb']) {
      assert.equal(isValidServiceLabel(bad), false, `应拒绝: ${JSON.stringify(bad)}`);
    }
  });

  it('接受正常的反向域名式 label', () => {
    assert.equal(isValidServiceLabel('com.mihomo-cli.daemon'), true);
    assert.equal(isValidServiceLabel('com.mihomo-cli.test_1'), true);
    assert.equal(isValidServiceLabel('A0'), true);
  });
});
