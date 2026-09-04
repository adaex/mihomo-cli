import { CliError } from '../errors.js';

/**
 * 已移除命令的墓碑 handler。
 *
 * 与仓库对 `--no-ssh` / `--mirror-all` 的处理同口径：显式报错说明去向，
 * 而不是删掉了事。删掉的话 `mihomo up` 会走 did-you-mean 被猜成 `update`
 * （提示用户去执行一条完全不相干、还会重装 CLI 的命令），
 * `mihomo daemon on` 更是文档里推荐过多个版本的写法，值得一条明确的迁移指引。
 */
export function removedCommand(name: string, version: string, hint: string[]): () => void {
  return () => {
    throw new CliError(`${name} 已移除（${version}）`, { label: '命令不存在', hint });
  };
}
