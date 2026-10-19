// Child process for the multi-process reserve race. Not a test file.
// Usage: bun reserve-worker.ts <dir> <actionHash> <goFile>   -> prints {"token": string|null}
import fs from 'node:fs';
import { reserve } from '../../../../engine/lib/approvals.ts';

const [dir, hash, go] = process.argv.slice(2) as [string, string, string];
fs.writeFileSync(`${go}.ready.${process.pid}`, '');
const until = Date.now() + 30_000;
while (!fs.existsSync(go)) {
  if (Date.now() > until) throw new Error('barrier timeout');
  await new Promise((r) => setTimeout(r, 2));
}
const r = await reserve(hash, {}, { dir, lock: { timeoutMs: 60_000, staleMs: 60_000 } });
process.stdout.write(JSON.stringify({ token: r?.token ?? null }));
