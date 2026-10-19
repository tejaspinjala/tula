// Optional persisted snapshots of what engine/lib/derive.ts computes from events.jsonl (for fleetd / dashboards).
// Written through the locked, atomic store, so concurrent snapshotters cannot lose or corrupt each other's write.
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.ts';
import { deriveLinks, deriveCtx, parseEvents, LinksSnapshotSchema, CtxSnapshotSchema } from './derive.ts';

/** Derives links/ctx from `<stateDir>/events.jsonl` and writes `links.json` and `ctx.json` via store.write. */
export async function writeSnapshots(stateDir: string): Promise<void> {
  let text = '';
  try { text = fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8'); } catch { /* no events yet */ }
  const events = parseEvents(text);
  await store.write(path.join(stateDir, 'links.json'), deriveLinks(events), LinksSnapshotSchema);
  await store.write(path.join(stateDir, 'ctx.json'), deriveCtx(events), CtxSnapshotSchema);
}
