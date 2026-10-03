import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shellQuote } from '../text.js';
import { runModule } from './cli.js';
import { writeStubExecutable } from './stub-bin.js';

/**
 * 「桩 curl 记录 no_proxy/NO_PROXY + 固定响应」端到端夹具：curl spawn 的 env 代理策略
 * 回归闸（curl-spawn.ts 唯一出口的接线锚点）共用这一份骨架。CLAUDE.md 夹具纪律——
 * spawn 与 env 形态不在各 spec 重抄；接线被拔掉时对应用例转红（D11 反向验证）。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */

/** 桩 curl 拿 marker 路径的 env 变量名（各 spec 的桩脚本与驱动 env 共用，防拼写漂移） */
export const STUB_CURL_ENV_MARKER_ENV = 'MIHOMO_TEST_CURL_ENV_MARKER';

/** 复杂桩体（下载闸门等）拼入 env 记录的前导行：spawn 实见值落盘 markerPath.no_proxy/.NO_PROXY */
export const stubCurlEnvRecordLines = `printf '%s' "\${no_proxy-__UNSET__}" > "$MIHOMO_TEST_CURL_ENV_MARKER.no_proxy"
printf '%s' "\${NO_PROXY-__UNSET__}" > "$MIHOMO_TEST_CURL_ENV_MARKER.NO_PROXY"`;

/**
 * 读回桩实见的 no_proxy/NO_PROXY；桩没被调用过（如白名单用例拒绝先于下载）时
 * marker 文件不存在，按 __UNSET__ 哨兵返回——「未设置」与「置空成空串」是两种
 * 要区分开的观测
 */
export function readStubCurlEnv(dataDir: string): { noProxy: string; noProxyUpper: string } {
  const read = (suffix: string) => {
    const f = path.join(dataDir, `curl-env.${suffix}`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '__UNSET__';
  };
  return { noProxy: read('no_proxy'), noProxyUpper: read('NO_PROXY') };
}

/**
 * 起「PATH 前置的桩 curl（记录 env + printf 固定响应）+ 驱动脚本」的端到端用例夹具：
 * 桩体前自动拼 stubCurlEnvRecordLines，驱动 env 注入 no_proxy='*'/NO_PROXY='*'（模拟
 * 用户 shell 的例外表——不经 buildCurlSpawnEnv 置空就会绕过 -x）与 marker 路径。
 *
 * curlPrintfFormat 按 printf 格式串语义传入（\n/% 由 printf 解释，可伪造 -w 追加的
 * 末行状态码形态）；shellQuote 只防引号注入，不改变转义语义
 */
export function runWithEnvRecordingStubCurl(opts: { driverScript: string; curlPrintfFormat: string }): {
  status: number | null;
  stdout: string;
  stderr: string;
  env: { noProxy: string; noProxyUpper: string };
} {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-curl-env-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-curl-env-bin-'));
  try {
    writeStubExecutable(path.join(fakeBin, 'curl'), [stubCurlEnvRecordLines, `printf ${shellQuote(opts.curlPrintfFormat)}`, 'exit 0'].join('\n'));
    const r = runModule(opts.driverScript, dataDir, {
      env: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        [STUB_CURL_ENV_MARKER_ENV]: path.join(dataDir, 'curl-env'),
        no_proxy: '*',
        NO_PROXY: '*',
      },
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, env: readStubCurlEnv(dataDir) };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}
