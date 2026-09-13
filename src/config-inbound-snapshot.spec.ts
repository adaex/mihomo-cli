import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCKED_CONFIG_KEYS } from './config.js';
import { BASE_CONFIG } from './constants.js';

/**
 * 锁定清单的**完整性**测试（与 config.spec.ts 的行为测试分开：那边测「锁了的键确实被剥」，
 * 这边测「该锁的键一个都没漏」）。
 *
 * 存在的理由：`LOCKED_CONFIG_KEYS` 已连续五轮各漏一批——redir/tproxy（v4.9.0）、
 * -tls/-unix/-doh 与 tuic-server（v4.9.1）、ss-config/vmess-config（v4.9.2）、
 * listeners/tunnels（v4.12.0）、allow-lan 与鉴权家族（v4.13.0）——而**每一轮的复审
 * 记录都写着「这次逐个核对过了」**。人肉对一份会随上游漂移的字段集，失败率经验上接近
 * 100%，再仔细一点解决不了。
 *
 * ## 这个测试抓得住什么
 *
 * 上游字段集被冻结成下方快照后，任何一个字段要么在锁定表里，要么在
 * `NOT_IN_LOCKED_TABLE` 里带一条非空理由。**「没写决定」当场变红**——安全边界上
 * 不留「待定」，而「待定」在实现上等于放行（listeners/tunnels 以「未定的产品决策」
 * 挂了三个版本，期间订阅写了就照常进运行配置）。
 *
 * ## 这个测试抓不住什么（别误以为有了自动防线）
 *
 * **快照是冻结副本，上游新增字段它自己发现不了。** 上游加了个新入站键，这里不会红，
 * 照样漏。它的真实价值是把「凭记忆重新推导整张清单」降级成「拿结构体 diff 一份
 * 已存在的清单」，并让漏掉的决定无法静默通过。
 *
 * **因此：内核大版本升级时必须人工刷新下方快照**（CLAUDE.md 已记一条）。刷新方法不是
 * 按键名眼熟程度挑，而是照 `config.Inbound` 结构体字段全集 +
 * `hub/executor.updateListeners()` 里逐个 ReCreate* 的入参对表：进得去那份名单的都能开监听。
 */

/** 快照核对时间与来源：2026-09-13，上游 MetaCubeX/mihomo Meta 分支（内核 v1.19.30） */
const UPSTREAM_SNAPSHOT_VERSION = 'v1.19.30';

/**
 * 上游 `config.Inbound` 结构体的字段全集（json tag），加上 `RawConfig` 顶层里同属
 * 入站/控制面的键。来源：
 * - https://github.com/MetaCubeX/mihomo/blob/Meta/config/config.go （Inbound + RawConfig）
 * - https://github.com/MetaCubeX/mihomo/blob/Meta/hub/executor/executor.go （updateListeners）
 */
const UPSTREAM_INBOUND_FIELDS: readonly string[] = [
  // --- config.Inbound 结构体字段 ---
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'mixed-port',
  'tun',
  'tuic-server',
  'ss-config',
  'vmess-config',
  'authentication',
  'skip-auth-prefixes',
  'lan-allowed-ips',
  'lan-disallowed-ips',
  'allow-lan',
  'bind-address',
  'inbound-tfo',
  'inbound-mptcp',
  // --- RawConfig 顶层的控制面与监听声明 ---
  'external-controller',
  'external-controller-tls',
  'external-controller-unix',
  'external-controller-pipe',
  'external-controller-cors',
  'external-controller-routing-mark',
  'external-doh-server',
  'external-ui',
  'external-ui-name',
  'external-ui-url',
  'secret',
  'listeners',
  'tunnels',
  'tls',
];

/**
 * 实际不会进入运行配置的键。`tls` 不在 `LOCKED_CONFIG_KEYS` 数组里——它由 config.ts
 * 在剥除循环之后单独 `delete`，效果等同。测试认的是**效果**而非数组成员资格，
 * 否则这条旁路会让测试恒红。
 */
const EFFECTIVELY_STRIPPED = new Set<string>([...LOCKED_CONFIG_KEYS, 'tls']);

/**
 * 刻意不锁的键 → 理由。空理由不算数（见下方断言）：这张表的意义就是逼出一句
 * 「为什么放它进来是安全的」。
 */
const NOT_IN_LOCKED_TABLE: Record<string, string> = {
  iptables: 'Linux 专用的系统集成开关，非监听；darwin 内核无该路径',
  'inbound-tfo': 'TCP Fast Open 的传输层 socket 选项，不开监听、不改绑定地址、不绕鉴权',
  'inbound-mptcp': 'MPTCP 的传输层 socket 选项，同 inbound-tfo',
  tun: '不由锁定表管，而是按启动模式整段接管：tun 模式写入 TUN_CONFIG，mixed 模式 delete withOverwrites.tun，订阅同样改不了',
};

describe(`锁定清单完整性：对表上游 config.Inbound 字段快照（${UPSTREAM_SNAPSHOT_VERSION}）`, () => {
  it('快照里每个上游入站/控制面字段，要么被剥除，要么写明了刻意放行的理由', () => {
    const undecided: string[] = [];
    for (const field of UPSTREAM_INBOUND_FIELDS) {
      if (EFFECTIVELY_STRIPPED.has(field)) continue;
      const reason = NOT_IN_LOCKED_TABLE[field];
      if (!reason || reason.trim() === '') undecided.push(field);
    }
    assert.deepEqual(
      undecided,
      [],
      `以下上游入站/控制面字段既不在锁定表里，也没写明刻意放行的理由: ${undecided.join('、')}。` +
        '安全边界上不留「待定」——「待定」在实现上等于放行（listeners/tunnels 曾这样挂了三个版本）。' +
        '要么加进 LOCKED_CONFIG_KEYS，要么在 NOT_IN_LOCKED_TABLE 里写清为什么放它进来是安全的。',
    );
  });

  it('「刻意放行」与「已剥除」不能同时成立（自相矛盾守卫）', () => {
    const contradictory = Object.keys(NOT_IN_LOCKED_TABLE).filter(k => EFFECTIVELY_STRIPPED.has(k));
    assert.deepEqual(contradictory, [], `这些键既被剥除又被记成刻意放行，理由已过期应删掉: ${contradictory.join('、')}`);
  });

  it('「刻意放行」表里没有快照外的过期条目', () => {
    const snapshot = new Set(UPSTREAM_INBOUND_FIELDS);
    // iptables 是 RawConfig 里的系统集成开关、不属入站字段快照，故豁免这条检查
    const stale = Object.keys(NOT_IN_LOCKED_TABLE).filter(k => k !== 'iptables' && !snapshot.has(k));
    assert.deepEqual(stale, [], `这些键已不在上游快照里，理由条目应随之删除: ${stale.join('、')}`);
  });

  it('锁定表自身无重复项（复制粘贴加键时的常见手误）', () => {
    const counts = new Map<string, number>();
    for (const k of LOCKED_CONFIG_KEYS) counts.set(k, (counts.get(k) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(dupes, [], `LOCKED_CONFIG_KEYS 有重复项: ${dupes.join('、')}`);
  });

  // 两张表语义互斥：BASE_CONFIG 是「用户没写时的默认」（可被订阅/覆写覆盖），
  // 锁定表是「恒定此值」。同一个键落进两张表**不会报错也不会有行为差异**——
  // BASE_CONFIG 那份直接成了死配置（填充循环的 `key in withOverwrites` 判据先跑、
  // 剥除循环随后删键，最终值由 systemConfig 说了算）。实测确认过：把 allow-lan 塞回
  // BASE_CONFIG，699 条测试全绿。死配置比缺陷更难发现，故在这里挡住
  it('BASE_CONFIG 与锁定表无交集：默认值与恒定值是两种语义，混表会留下死配置', () => {
    const overlap = Object.keys(BASE_CONFIG).filter(k => (LOCKED_CONFIG_KEYS as readonly string[]).includes(k));
    assert.deepEqual(
      overlap,
      [],
      `这些键同时在 BASE_CONFIG 与 LOCKED_CONFIG_KEYS 里: ${overlap.join('、')}。` +
        '锁定项的恒定值应由 config.ts 的 systemConfig 写入（同 mixed-port/allow-lan），BASE_CONFIG 里那份是死配置。',
    );
  });
});
