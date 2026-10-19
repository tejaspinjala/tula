// Child-process worker for the cross-process store/lock/chain tests. Not a test file itself.
// Usage: bun worker.ts <mode> <file> [args...]
//   update <file> <n> <goFile>        -> n x store.update incrementing { count }
//   append <file> <n> <goFile> <id>   -> n x chain.append({ w: id, i })
//   crash  <file> <point>             -> store.write with a fault injector that exits mid-write
import fs from 'node:fs';
import { update, write, __setFaultInjector, type FaultPoint } from '../../../../engine/lib/store.ts';
import { append } from '../../../../engine/lib/chain.ts';
import { counterSchema } from './schemas.ts';

const [mode, file, ...rest] = process.argv.slice(2);

async function waitFor(go: string): Promise<void> {
  fs.writeFileSync(`${go}.ready.${process.pid}`, '');
  const until = Date.now() + 30_000;
  while (!fs.existsSync(go)) {
    if (Date.now() > until) throw new Error('barrier timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const lockOpts = { timeoutMs: 120_000, staleMs: 60_000 };

if (mode === 'update') {
  const n = Number(rest[0]);
  await waitFor(rest[1]);
  for (let i = 0; i < n; i++) {
    await update(file, counterSchema, (cur) => ({ count: (cur?.count ?? 0) + 1 }), lockOpts);
  }
} else if (mode === 'append') {
  const n = Number(rest[0]);
  await waitFor(rest[1]);
  const id = rest[2];
  for (let i = 0; i < n; i++) await append(file, { w: id, i }, lockOpts);
} else if (mode === 'crash') {
  const point = rest[0] as FaultPoint;
  __setFaultInjector((p) => {
    if (p === point) process.exit(137); // simulated crash: no cleanup, no finally, lock left behind
  });
  await write(file, { count: 999 }, counterSchema);
  process.exit(3); // must not get here
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
