/**
 * 全仓 curl 子进程的统一代理策略出口（连通性探测、release API 查询、内核产物下载）。
 * 新增 curl spawn 必须经此出口，不得另写 env 代理处理。
 *
 * 判据：no_proxy/NO_PROXY 例外表会**绕过显式 -x**（实测 curl 8.7），用户 export 过
 * no_proxy 时代理通道会被静默改成直连——故 env 层对所有通道置空（空串即「无例外」）。
 * 只作用于本次 spawn，不写 process.env。
 *
 * 分工：本函数管 env 层；直连的 `--noproxy '*'` 在 args 层（buildKernelCurlArgs /
 * buildReleaseApiCurlArgs）。代理通道 args 绝不能加 --noproxy（它优先于 -x，会废掉代理）。
 */
export function buildCurlSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.no_proxy = '';
  env.NO_PROXY = '';
  return env;
}
