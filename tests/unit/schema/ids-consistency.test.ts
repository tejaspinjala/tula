// engine/schema/common.ts keeps its own ID_RE (the schema package does not import engine/lib). When
// engine/lib/ids.ts (slice P0-3) is present, ids it generates must match ID_RE. Before P0-3 merges the file
// is absent and this test only records that.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE } from '../../../engine/schema/index.ts';
import { repoRoot } from '../../helpers.ts';

const idsPath = path.join(repoRoot, 'engine', 'lib', 'ids.ts');

test('ID_RE matches engine/lib/ids.ts newId() output (when present)', async () => {
  if (!fs.existsSync(idsPath)) {
    expect(fs.existsSync(idsPath)).toBe(false);
    return;
  }
  const mod = (await import(idsPath)) as { newId?: (prefix: string, now?: number) => string };
  expect(typeof mod.newId).toBe('function');
  for (const prefix of ['task', 'run', 'apr', 'wfi', 'grant', 'a1']) {
    for (const now of [0, Date.UTC(2026, 9, 18), 2 ** 48 - 1]) {
      const generated = mod.newId!(prefix, now);
      expect(ID_RE.test(generated)).toBe(true);
    }
  }
});
