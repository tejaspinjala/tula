// Table-driven fixture tests: every valid fixture parses, every invalid fixture fails for its stated reason.
import { describe, expect, test } from 'bun:test';
import { ENTITY_NAMES, NODE_TYPES, schemas } from '../../../engine/schema/index.ts';
import { fixtureEntities, loadFixtures } from './fixtures.ts';

describe('fixture coverage', () => {
  test('every entity has >= 2 valid and >= 2 invalid fixtures', () => {
    const short = ENTITY_NAMES.filter((e) => {
      const f = loadFixtures(e);
      return f.filter((x) => x.kind === 'valid').length < 2 || f.filter((x) => x.kind === 'invalid').length < 2;
    });
    expect(short).toEqual([]);
  });

  test('every fixture directory belongs to a registered entity', () => {
    expect(fixtureEntities().filter((d) => !(d in schemas))).toEqual([]);
  });

  test('a valid workflow fixture uses every node type', () => {
    const coveredByOne = loadFixtures('workflow')
      .filter((f) => f.kind === 'valid')
      .map((f) => new Set(((f.data as { nodes: { type: string }[] }).nodes ?? []).map((n) => n.type)));
    expect(coveredByOne.some((types) => NODE_TYPES.every((t) => types.has(t)))).toBe(true);
  });
});

for (const entity of ENTITY_NAMES) {
  describe(`schema ${entity}`, () => {
    const schema = schemas[entity];
    for (const f of loadFixtures(entity)) {
      if (f.kind === 'valid') {
        test(`${f.file} parses`, () => {
          expect(f.why).toBeUndefined();
          const r = schema.safeParse(f.data);
          expect(r.success ? [] : r.error.issues).toEqual([]);
        });
      } else {
        test(`${f.file} is rejected: ${f.why}`, () => {
          expect(typeof f.why === 'string' && f.why.length > 0).toBe(true);
          expect(Array.isArray(f.path)).toBe(true);
          const r = schema.safeParse(f.data);
          expect(r.success).toBe(false);
          const paths = r.success ? [] : r.error.issues.map((i) => JSON.stringify(i.path));
          expect(paths).toContain(JSON.stringify(f.path));
        });
      }
    }
  });
}
