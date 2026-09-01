import fs from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';
import { deepMergeWithOverrides } from './overwrite.js';
import { USER_DATA_DIR } from './paths.js';
import { validateSshName } from './settings.js';
import type { SshConfig, SshFileEntry } from './types.js';

/**
 * ssh 隧道的配置侧：文件加载、节点合成、与主配置的合并。
 *
 * 与 `ssh.ts`（进程生命周期）分家的理由是依赖方向：`config.ts` 要在 buildConfig 里
 * 调用本模块，而 `ssh.ts` 依赖 `process.ts`，`process.ts` 又依赖 `config.ts`——
 * config 直接引 ssh.ts 会成环。本模块刻意只依赖纯数据层（settings/overwrite/paths）。
 *
 * 与 overwrite 的关系是「同语法、不同开关」：复用 `deepMergeWithOverrides` 的
 * `~`/`+` 语义，但**不受 `ow off` 影响**——覆写是可选调优，内网分流是刚需，
 * 用户关掉前者时不该连带断掉后者。
 */

/** `ssh.<名字>.yaml`。与 isOverwriteFilename 的 `overwrite.*.yaml` 互不相交，两套文件天然隔离。 */
const SSH_FILENAME_RE = /^ssh\.(.+)\.ya?ml$/;

export function isSshFilename(filename: string): boolean {
  return SSH_FILENAME_RE.test(filename);
}

export function getSshConfigPath(name: string): string {
  // 二次校验防路径穿越：名字正常经 addSshTunnel 校验，但 settings.json 可被手改成 ../ 之类
  validateSshName(name);
  return path.join(USER_DATA_DIR, `ssh.${name}.yaml`);
}

/**
 * 隧道名首字母大写，供展示型的节点/分组名使用。
 * 名字已过 SAFE_NAME_RE（仅字母数字下划线短横线与中文），不含代理对字符，
 * 故 charAt(0) 安全；中文名 toUpperCase 无变化，原样返回。
 */
function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** 注入节点名。整名唯一，供分组引用与 include-all 排除共用。SSH 是协议缩写，恒全大写。 */
export function getSshProxyName(name: string): string {
  return `SSH-${capitalize(name)}-Host`;
}

export function getSshGroupName(name: string): string {
  return `SSH-${capitalize(name)}`;
}

/**
 * 由隧道配置合成 socks5 节点。**这是节点定义的唯一来源**：此前节点写在用户维护的
 * 覆写文件里，与 settings 里的 host/port 构成两份真相，改端口后二者漂移且无任何提示
 * （实测 rm 再 add 换端口，配置仍指向旧端口，静默失效）。
 */
export function renderSshProxy(tunnel: SshConfig): Record<string, unknown> {
  return {
    name: getSshProxyName(tunnel.name),
    type: 'socks5',
    server: '127.0.0.1',
    port: tunnel.port,
  };
}

/** 供 include-all 排除用的注入节点名清单。 */
export function collectSshProxyNames(tunnels: SshConfig[]): string[] {
  return tunnels.map(t => getSshProxyName(t.name));
}

/**
 * 加载全部 `ssh.*.yaml`。按文件名排序（顺序只影响用户自己写的字段，
 * CLI 注入的节点恒在最后合并，不受此顺序影响）。
 */
export function loadSshConfigFiles(): SshFileEntry[] {
  if (!fs.existsSync(USER_DATA_DIR)) return [];

  const files = fs.readdirSync(USER_DATA_DIR).filter(isSshFilename).sort();
  const results: SshFileEntry[] = [];

  for (const file of files) {
    const filePath = path.join(USER_DATA_DIR, file);
    try {
      // 别名上限防 YAML 炸弹 DoS（同 config.ts SAFE_YAML_LOAD_OPTIONS，此处内联避免循环依赖）
      const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'), { maxAliases: 200 }) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // match 是 overwrite 专属的作用域元数据键。ssh 隧道是机器级出口、与订阅无关，
        // 故不支持；若原样留下会被当普通配置键写进 mihomo 配置。剥离并告警，
        // 免得用户以为自己限定了作用域而实际全局生效
        if ('match' in parsed) {
          console.warn(`警告: ssh 配置 "${file}" 的 match 块不生效（ssh 隧道恒全局），已忽略`);
          delete parsed.match;
        }
        results.push({ name: file, path: filePath, config: parsed });
      } else if (parsed !== null) {
        console.warn(`警告: ssh 配置 "${file}" 顶层必须是对象，已跳过`);
      }
    } catch (e) {
      console.warn(`警告: ssh 配置 "${file}" 解析失败: ${(e as Error).message}`);
    }
  }

  return results;
}

/**
 * 把 ssh 隧道相关配置合并进主配置。
 *
 * **顺序不可调换**：先合用户文件，再注入 CLI 合成的节点。`~proxies` 是字段级合并且
 * 后合并者胜（实测先注入 port 1080、再合用户手写的同名 `{port: 9999}`，结果为 9999），
 * 因此只有把 CLI 注入放在最后，host/port 才恒以 settings 为准——否则用户手写一个同名
 * 节点就能让配置与 `ssh status` 显示的端口对不上，又退回两份真相。
 */
export function applySshConfig(baseConfig: Record<string, unknown>, sshFiles: SshFileEntry[], tunnels: SshConfig[]): Record<string, unknown> {
  // 恒返回浅拷贝，与 applyOverwrite 同口径：buildConfig 随后会 delete 锁定键，
  // 直接返回入参会污染上游对象（调试用的分阶段文件也会随之失真）
  let result = { ...baseConfig };

  for (const file of sshFiles) {
    result = deepMergeWithOverrides(result, file.config);
  }

  if (tunnels.length > 0) {
    result = deepMergeWithOverrides(result, { '~proxies': tunnels.map(renderSshProxy) });
  }

  return result;
}

/**
 * 配置模板。**不含节点定义**——节点由 CLI 从 settings 注入，写进模板会让用户以为
 * 改这里能改端口。只给分组骨架与注释掉的规则示例：CLI 无从知道用户的内网域名。
 *
 * 手写字符串而非 dumpYaml：模板要带解释性注释。name 已过 SAFE_NAME_RE、port 是整数，
 * 无 YAML 转义风险。
 */
export function renderSshConfigTemplate(tunnel: SshConfig): string {
  const proxyName = getSshProxyName(tunnel.name);
  const groupName = getSshGroupName(tunnel.name);
  return `# mihomo-cli ssh 隧道配置（ssh: ${tunnel.name}）
# 本文件由 mihomo-cli 首次创建，之后完全由你维护——CLI 不会再改写或删除它。
#
# 节点 ${proxyName} 由 CLI 依据 settings 里的 host/port 自动注入，
# 无需也不要在此声明：端口以 \`mihomo ssh\` 显示的为准，改端口用 \`mihomo ssh add\`。
#
# 本文件不受 \`mihomo ow off\` 影响（ssh 分流是刚需，覆写是可选调优）。
# ~ 是「按 name 就地合并」语义，不依赖文件加载顺序。

~proxy-groups:
  - name: ${groupName}
    type: select
    proxies:
      - ${proxyName}
      - DIRECT

# 取消注释并填入需要走隧道的内网域名/网段（CLI 无从知道你的内网地址）：
# +rules:
#   - DOMAIN-SUFFIX,example.internal,${groupName}
#   - IP-CIDR,10.0.0.0/8,${groupName}
`;
}

/**
 * 仅当文件不存在时生成模板，返回是否新建。
 * 绝不覆盖已有文件——它是用户维护的资产，覆盖等于不可恢复地丢掉用户写的分流规则。
 */
export function ensureSshConfigFile(tunnel: SshConfig): boolean {
  const filePath = getSshConfigPath(tunnel.name);
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(USER_DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, renderSshConfigTemplate(tunnel), { mode: 0o600 });
  return true;
}
