// The JSON Schema export: --check logic, file shape, and fixture round-trip through the exported schemas.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENTITY_NAMES, LIBRARY_NAMES, OWNER_LOCKED_FIELDS } from '../../../engine/schema/index.ts';
import { check, diffSummary, generate, JSON_DIR, loadModules, moduleNames, readOnDisk } from '../../../engine/schema/export.ts';
import { repoRoot } from '../../helpers.ts';
import { loadFixtures } from './fixtures.ts';
import { validate } from './mini-json-schema.ts';

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(JSON_DIR, `${name}.schema.json`), 'utf8')) as Record<string, any>;

describe('schema:export --check', () => {
  test('committed index.ts and json/*.schema.json match a fresh in-memory export', async () => {
    expect(await check()).toEqual([]);
  });

  test('one module per entity: index.ts registers every module except the libraries', async () => {
    const mods = await loadModules();
    expect(mods.map((m) => m.name)).toEqual(moduleNames());
    expect(([...ENTITY_NAMES, ...LIBRARY_NAMES] as string[]).sort()).toEqual(moduleNames());
    expect(LIBRARY_NAMES as readonly string[]).toEqual(['common']);
  });

  test('diffSummary reports changed, missing and stale files', async () => {
    const expected = generate(await loadModules());
    const actual = new Map(readOnDisk());
    expect(diffSummary(expected, actual)).toEqual([]);
    const tampered = new Map(actual);
    tampered.set('json/task.schema.json', actual.get('json/task.schema.json')!.replace('"title"', '"titel"'));
    tampered.delete('json/team.schema.json');
    tampered.set('json/ghost.schema.json', '{}\n');
    tampered.set('index.ts', actual.get('index.ts') + '// hand edit\n');
    const problems = diffSummary(expected, tampered);
    expect(problems.some((p) => p.startsWith('json/task.schema.json: differs at line'))).toBe(true);
    expect(problems).toContain('json/team.schema.json: missing');
    expect(problems).toContain('json/ghost.schema.json: stale (no schema module generates it)');
    expect(problems.some((p) => p.startsWith('index.ts: differs at line'))).toBe(true);
    expect(problems).toHaveLength(4);
  });

  test('the CLI exits 0 on a clean tree and 2 on an unknown flag', () => {
    const ok = spawnSync('bun', ['run', 'schema:export', '--check'], { cwd: repoRoot, encoding: 'utf8' });
    expect(ok.status).toBe(0);
    const bad = spawnSync('bun', ['engine/schema/export.ts', '--chek'], { cwd: repoRoot, encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});

describe('exported JSON Schema files', () => {
  test.each([...ENTITY_NAMES, ...LIBRARY_NAMES])('%s is 2020-12 with $id = file name', (name) => {
    const js = readJson(name);
    expect(js.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(js.$id).toBe(name);
  });

  test.each(ENTITY_NAMES.filter((n) => n !== 'node-types'))('%s rejects unknown top-level keys', (name) => {
    expect(readJson(name).additionalProperties).toBe(false);
  });

  test('node-types and workflow carry one $defs entry per node type', () => {
    for (const file of ['node-types', 'workflow']) {
      const defs = readJson(file).$defs as Record<string, unknown>;
      for (const t of ['trigger.schedule', 'trigger.manual', 'trigger.event', 'trigger.webhook', 'agent', 'verify', 'judge', 'approval',
        'action', 'branch', 'fanout', 'fanin', 'loop', 'wait', 'notify', 'set', 'subworkflow']) {
        expect(defs[t]).toBeDefined();
      }
    }
  });

  test('privateEligible is annotated owner-locked in providers.schema.json', () => {
    const js = readJson('providers');
    expect(js.$defs.provider.properties.privateEligible['x-ownerLocked']).toBe(true);
    expect(js.$defs.provider.required).toContain('privateEligible');
    expect(OWNER_LOCKED_FIELDS as readonly string[]).toEqual(['providers/*/privateEligible']);
  });

  test('defaults are optional in the exported (input) schema', () => {
    const common = readJson('common');
    expect(common.$defs.doneCondition.required).toEqual(['kind', 'spec']);
    expect(common.$defs.doneCondition.properties.timeoutSec.default).toBe(300);
  });
});

describe('round-trip: fixtures validate against the exported JSON Schema', () => {
  for (const entity of ENTITY_NAMES) {
    for (const f of loadFixtures(entity)) {
      if (f.kind !== 'valid') continue;
      test(`${entity}/${f.file}`, () => {
        expect(validate(readJson(entity), f.data)).toEqual([]);
      });
    }
  }

  // Invalid fixtures whose rule is structural (not a Zod refinement) must also fail the JSON Schema.
  for (const entity of ENTITY_NAMES) {
    for (const f of loadFixtures(entity)) {
      if (f.kind !== 'invalid') continue;
      test(`${entity}/${f.file} (structural rules fail in JSON Schema too; refinements may pass)`, async () => {
        const { schemas } = await import('../../../engine/schema/index.ts');
        const r = schemas[entity].safeParse(f.data);
        const structural = !r.success && r.error.issues.some((i) => JSON.stringify(i.path) === JSON.stringify(f.path) && i.code !== 'custom');
        if (structural) expect(validate(readJson(entity), f.data).length).toBeGreaterThan(0);
      });
    }
  }
});
