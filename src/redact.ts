import { maskUrl } from './settings.js';

/**
 * 配置凭据脱敏：`mihomo config` 可能被录屏、`| pbcopy` 发给别人求助，
 * 只脱敏顶层 secret 挡不住节点与 provider 里的明文凭据。
 *
 * 敏感键按上游各出站协议的实际凭据字段收集（小写带连字符形态）：
 * - password：ss / trojan / snell / tuic / anytls / http / socks5 等
 * - uuid：vmess / vless / tuic
 * - private-key：WireGuard 客户端私钥
 * - pre-shared-key：旧版 tuic
 * - auth-str：hysteria / hysteria2
 * - secret：external-controller 访问密钥（顶层）
 * 这些键出现在任意嵌套层（如各类 plugin-opts）都掩码，递归不遗漏。
 *
 * provider 容器（proxy-providers / rule-providers）内的 `url` 是订阅/规则集地址，
 * query 里普遍带订阅 token（README 的覆写示例本身就含 ?token=xxx），复用 maskUrl。
 * 容器外的 url（如 url-test 分组的 gstatic 探测地址）不动。
 */
const SECRET_KEYS = new Set(['password', 'uuid', 'private-key', 'pre-shared-key', 'auth-str', 'secret']);

const URL_PROVIDER_KEYS = new Set(['proxy-providers', 'rule-providers']);

export interface RedactResult {
  config: unknown;
  /** 是否真的发生过脱敏（命令层据此决定要不要提示，避免无凭据配置也显示「已脱敏」） */
  changed: boolean;
}

function walk(node: unknown, withinProvider: boolean, state: { changed: boolean }): unknown {
  if (Array.isArray(node)) {
    return node.map(item => walk(item, withinProvider, state));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && SECRET_KEYS.has(key.toLowerCase())) {
        out[key] = '***';
        state.changed = true;
      } else if (typeof value === 'string' && withinProvider && key === 'url') {
        const masked = maskUrl(value);
        out[key] = masked;
        // URL 里没有 token/userinfo/长路径段时 maskUrl 原样返回，不算发生过脱敏
        if (masked !== value) state.changed = true;
      } else {
        // 进入 provider 容器后，下一层的每个条目都按 provider 条目处理（其 url 脱敏）
        out[key] = walk(value, withinProvider || URL_PROVIDER_KEYS.has(key), state);
      }
    }
    return out;
  }
  return node;
}

/**
 * 返回脱敏后的深拷贝（输入不被修改）与是否发生过脱敏。
 * 输入是 YAML/JSON 解析出的纯数据，无函数/Symbol，普通递归复制即可。
 */
export function redactConfigSecrets(config: unknown): RedactResult {
  const state = { changed: false };
  return { config: walk(config, false, state), changed: state.changed };
}
