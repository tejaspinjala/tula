// docs/PHASE-1-PLAN.md section 3 is the human-readable contract; engine/schema (Zod) is canonical. This test
// fails when they drift: every section-3 JSON block with an `$id` must match the exported JSON Schema by
// property names and required sets, at every nested inline object and in `$defs`. Intentional divergences
// are listed in DECLARED_DIVERGENCES (and in engine/schema/README.md); anything else fails.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { ENTITY_NAMES, ID_RE, LIBRARY_NAMES, schemas } from '../../../engine/schema/index.ts';
import { JSON_DIR } from '../../../engine/schema/export.ts';
import { compareDeep, planSection3Blocks, type Json } from './plan-blocks.ts';
import { validate } from './mini-json-schema.ts';

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(JSON_DIR, `${name}.schema.json`), 'utf8')) as Json;

/** Plan `$defs` names that were renamed in the export. */
const DEF_RENAMES: Record<string, Record<string, string>> = {
  common: { ulid: 'id' },
};

/** Exact expected compareDeep() output per block. Keep in sync with README "Divergences from the plan". */
const DECLARED_DIVERGENCES: Record<string, Record<string, unknown>> = {
  // Node `type` is a literal discriminant per node variant, so no shared nodeType enum is referenced from
  // workflow.schema.json. The enum still exists in Zod (NODE_TYPES / nodeType in node-types.ts).
  workflow: { '/$defs/nodeType': 'missing' },
};

const blocks = planSection3Blocks();
const withId = blocks.filter((b) => typeof b.$id === 'string');

describe('PHASE-1-PLAN section 3 matches the export', () => {
  test('section 3 has a block for every plan-defined entity and every block names an exported schema', () => {
    const exported = new Set<string>([...ENTITY_NAMES, ...LIBRARY_NAMES]);
    expect(withId.map((b) => b.$id).filter((id) => !exported.has(id))).toEqual([]);
    expect(withId.map((b) => b.$id).sort()).toEqual([
      'access-grant', 'approval', 'common', 'config-version', 'connection', 'connector-manifest', 'event', 'handoff', 'node-types', 'run',
      'scorecard', 'spend-request', 'task', 'team', 'template', 'verdict', 'workflow', 'workflow-instance',
    ]);
  });

  for (const block of withId) {
    test(`${block.$id}: property names and required sets`, () => {
      const diffs = compareDeep(block, readJson(block.$id), DEF_RENAMES[block.$id] ?? {});
      expect(diffs).toEqual((DECLARED_DIVERGENCES[block.$id] ?? {}) as typeof diffs);
    });
  }

  test('the comparison is not vacuous: a dropped nested property is reported', () => {
    const plan = withId.find((b) => b.$id === 'connection')!;
    const ex = readJson('connection');
    delete ex.properties.auth.properties.identity;
    ex.properties.posting.required = ['mode'];
    expect(compareDeep(plan, ex)).toEqual({
      '/properties/auth': { addedProperties: [], removedProperties: ['identity'], addedRequired: [], removedRequired: [] },
      '/properties/posting': { addedProperties: [], removedProperties: [], addedRequired: [], removedRequired: ['dailyLimit'] },
    });
  });

  test('declared divergence: ids use the engine/lib/ids.ts format, not a bare ULID', () => {
    const common = withId.find((b) => b.$id === 'common')!;
    expect(common.$defs.ulid.pattern).toBe('^[0-9A-HJKMNP-TV-Z]{26}$');
    expect(readJson('common').$defs.id.pattern).toBe(ID_RE.source);
  });

  test("the plan's example youtube manifest is a valid ConnectorManifest (Zod and exported JSON Schema)", () => {
    const yt = blocks.find((b) => b.id === 'youtube' && !b.$id)!;
    expect(yt).toBeDefined();
    const r = schemas['connector-manifest'].safeParse(yt);
    expect(r.success ? [] : r.error.issues).toEqual([]);
    expect(validate(readJson('connector-manifest'), yt)).toEqual([]);
  });
});
