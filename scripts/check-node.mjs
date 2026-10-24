// pretest 守卫：Node 低于 engines 下限时，CLI 入口守卫会拒跑，测试只见大面积「输出为空」
// 的断言失败、看不出原因。这里先给一行明确报错。下限唯一来源是 package.json 的 engines.node。
import { readFileSync } from 'node:fs';
import { satisfies } from 'compare-versions';

const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (engines?.node && !satisfies(process.versions.node, engines.node)) {
  console.error(`Node 版本过低：当前 ${process.versions.node}，需要 ${engines.node}；请用版本管理器切换到 .node-version 指定的版本`);
  process.exit(1);
}
