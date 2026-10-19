import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const workerPath = path.join(import.meta.dir, 'fixtures', 'worker.ts');

/** Fresh temp dir (realpath'd) + FLEET_HOME pointed at it. Call cleanup() in afterEach. */
export function tempHome(): { dir: string; cleanup: () => void } {
  const prev = process.env.FLEET_HOME;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tula-fleet-lib-')));
  process.env.FLEET_HOME = dir;
  return {
    dir,
    cleanup: () => {
      if (prev === undefined) delete process.env.FLEET_HOME;
      else process.env.FLEET_HOME = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Spawns `count` workers that all start at a shared barrier; resolves with their exit codes and stderr. */
export async function runWorkers(count: number, args: (i: number) => string[], goFile: string): Promise<{ code: number; err: string }[]> {
  const procs = Array.from({ length: count }, (_, i) =>
    Bun.spawn([process.execPath, workerPath, ...args(i)], { stdout: 'ignore', stderr: 'pipe' }));
  // Wait until every worker has booted and reached the barrier, so they really start together.
  const dir = path.dirname(goFile);
  const tag = path.basename(goFile) + '.ready.';
  const until = Date.now() + 60_000;
  while (fs.readdirSync(dir).filter((n) => n.startsWith(tag)).length < count && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(goFile, 'go');
  return Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
}

/** A pid that existed and has exited (so it is dead on this host). */
export async function deadPid(): Promise<number> {
  const p = Bun.spawn(['true']);
  await p.exited;
  return p.pid;
}
