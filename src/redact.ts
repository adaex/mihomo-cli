import { maskUrl } from './settings.js';

/**
 * 配置凭据脱敏：`mihomo-cli config` 可能被录屏、`| pbcopy` 发给别人求助，
 * 只脱敏顶层 secret 挡不住节点与 provider 里的明文凭据。
 *
 * 敏感键按上游各出站协议的实际凭据字段收集（小写带连字符形态）：
 * - password：ss / trojan / snell / tuic / anytls / http / socks5 等
 * - uuid：vmess / vless / tuic
 * - private-key：WireGuard 客户端私钥
 * - pre-shared-key：旧版 tuic
 * - auth-str：hysteria / hysteria2
 * - auth：hysteria(1.x) 旧版 base64 认证字段（与 auth-str 并存期写法）
 * - obfs-password：hysteria2 salamander/gecko 混淆密码
 * - token：hysteria2 realm-opts 的 realm 认证令牌（词义较泛，误伤面仅限展示层掩码）
 * - secret：external-controller 访问密钥（顶层）
 * 这些键出现在任意嵌套层（如各类 plugin-opts）都掩码，递归不遗漏。
 *
 * provider 容器（proxy-providers / rule-providers）内的 `url` 是订阅/规则集地址，
 * query 里普遍带订阅 token（README 的覆写示例本身就含 ?token=xxx），复用 maskUrl。
 * 容器外的 url（如 url-test 分组的 gstatic 探测地址）不动。
 */
const SECRET_KEYS = new Set(['password', 'uuid', 'private-key', 'pre-shared-key', 'auth-str', 'auth', 'obfs-password', 'token', 'secret']);

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
      // '__proto__' 经对象字面赋值会命中原型 setter：own 键静默丢失、副本原型被换掉，
      // 随后的 dumpYaml 抛「unacceptable kind of an object to dump」让 mihomo-cli config
      // 按程序 bug 渲染（订阅内容可携带 own __proto__ 键，与覆写合并层同族问题的展示路径漏网）。
      // defineProperty 绕开 setter，保住键与其内容，副本仍是普通对象
      const assign = (v: unknown): void => {
        if (key === '__proto__') {
          Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
        } else {
          out[key] = v;
        }
      };
      if (typeof value === 'string' && SECRET_KEYS.has(key.toLowerCase())) {
        assign('***');
        state.changed = true;
      } else if (typeof value === 'string' && withinProvider && key === 'url') {
        const masked = maskUrl(value);
        assign(masked);
        // URL 里没有 token/userinfo/长路径段时 maskUrl 原样返回，不算发生过脱敏
        if (masked !== value) state.changed = true;
      } else {
        // 进入 provider 容器后，下一层的每个条目都按 provider 条目处理（其 url 脱敏）
        assign(walk(value, withinProvider || URL_PROVIDER_KEYS.has(key), state));
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
