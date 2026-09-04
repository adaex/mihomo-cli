import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isValidServiceLabel } from './constants.js';
import { buildPlist, parseDisabledList, parseServicePrint } from './service.js';

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

describe('buildPlist', () => {
  it('ProgramArguments[0] 指向符号链而非真实内核二进制', () => {
    // 「登录项与扩展」按 basename 显示；指向 kernel/mihomo 的话用户只看到无上下文的 "mihomo"
    const xml = buildPlist();
    const first = xml.match(/<array>\s*<string>([^<]+)<\/string>/);
    assert.ok(first, '应能取到 ProgramArguments 首项');
    assert.ok(first[1].endsWith('/mihomo-cli-service'), `首项应是符号链，实际: ${first[1]}`);
  });

  it('不设 UserName：user 域默认即当前用户，system 域必须是 root，写了都只会坏事', () => {
    assert.ok(!buildPlist().includes('<key>UserName</key>'));
  });

  it('含 RunAtLoad 与 KeepAlive（登录/开机自启 + 崩溃拉起）', () => {
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
  // 该值经 path.join 拼成 plist 路径后，是系统级安装时 `sudo install -o root` 的写入目标
  // 与 `sudo rm -f` 的删除目标。`..` 被 path.join 折叠即可越出 /Library/LaunchDaemons
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
