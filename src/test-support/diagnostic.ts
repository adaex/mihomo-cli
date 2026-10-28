import fs from 'node:fs';
import path from 'node:path';

export interface DiagnosticRow {
  event: string;
  result: string;
  stage?: string;
  reason?: string;
  httpStatus?: number;
  exitCode?: number;
}

/** 服务测试只读已落盘的 JSONL；诊断事件 spec 的末尾换行严格断言仍由该 spec 自管。 */
export function readDiagnosticEvents(dataDir: string): DiagnosticRow[] {
  const file = path.join(dataDir, 'logs', 'diagnostic.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as DiagnosticRow);
}
