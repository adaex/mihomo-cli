import { colors } from './colors.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/**
 * 长操作的等待反馈。TTY 下显示转圈动画与经过秒数，fn 完成/失败后清除整行；
 * 非 TTY（管道/CI）降级为「开始」一行，不输出动画控制符。
 *
 * 只适用于 fn 自身不打印的场景（订阅下载、版本查询）：
 * fn 中途的输出会与动画行交错。有自身进度输出的操作（如内核下载的 curl 进度条）
 * 不要包它。
 */
export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    console.log(label);
    return fn();
  }
  const start = Date.now();
  let frame = 0;
  const render = (): void => {
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r${colors.cyan(FRAMES[frame])} ${label} ${colors.gray(`${secs}s`)}\x1b[K`);
    frame = (frame + 1) % FRAMES.length;
  };
  render();
  const timer = setInterval(render, INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stdout.write('\r\x1b[K');
  }
}
