/**
 * 全仓 curl 子进程的统一代理策略出口。当前三处 spawn 共用：
 * proxy-probe.ts 的连通性探测、kernel.ts 的 release API 代理查询、kernel.ts 的
 * 内核产物下载。新增加 curl spawn 必须经此出口，不得另写 env 代理处理。
 *
 * 判据：no_proxy/NO_PROXY 例外表会**绕过显式 -x**（实测 curl 8.7：命中目标 host 即
 * 直连，代理完全不经手）——用户 shell 里 export 过 no_proxy='*' 或含目标域条目时，
 * 通道决策被静默改写：proxy 通道考的是直连而非指定代理（直连被墙则健康代理被误报
 * 不通）；direct 通道虽已有 args 层 --noproxy '*' 挡 env 代理，但两形态并存让
 * 「例外表绕 -x」这一层语义漏给 proxy 通道，故 env 层对所有通道一视同仁置空。
 *
 * 置空用空串而非 delete：按 curl 语义，变量存在但为空即「无例外」，与不存在同效，
 * 显式置空可读，也防调用方漏继承时从别处补回。只作用于本次 spawn，不写 process.env。
 *
 * 防线分工：本函数管 env 层（保 -x 权威），直连通道的 --noproxy '*' 在 args 层
 * （buildKernelCurlArgs，单测锁死）——proxy 通道 args 绝不能加 --noproxy
 * （--noproxy 与 -x 并存时前者优先级更高，会废掉代理）。
 */
export function buildCurlSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.no_proxy = '';
  env.NO_PROXY = '';
  return env;
}
