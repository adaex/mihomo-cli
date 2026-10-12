// pretest 守卫：Node 低于 engines 下限时，CLI 入口的版本守卫会拒绝运行，测试只会看到
// 大面积「输出为空」的断言失败、看不出原因。这里先给一行明确报错。
// 下限唯一来源是 package.json 的 engines.node（只支持 `>=x.y.z` 形态，同 constants.ts）。
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const m = String(pkg.engines?.node ?? '').match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
if (m) {
  const need = m.slice(1).map(Number);
  const have = process.versions.node.split('.').map(Number);
  const cmp = need.findIndex((n, i) => have[i] !== n);
  if (cmp !== -1 && have[cmp] < need[cmp]) {
    console.error(`Node 版本过低：当前 ${process.versions.node}，需要 ${pkg.engines.node}（见 .node-version；fnm/nvm 进目录会自动切换）`);
    process.exit(1);
  }
}
