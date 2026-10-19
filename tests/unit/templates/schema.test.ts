import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { templateSchema } from '../../../engine/schema/template.ts';
import { BUILTIN_TEMPLATES_DIR, listBuiltinTemplates, loadTemplateDir } from '../../../engine/template/load.ts';
import { KIND_TABLE } from '../../../engine/home/kinds.ts';
import { cleanupTmp, copyTemplate, tmp, readJson, writeJson } from './util.ts';
import { afterEach } from 'bun:test';

afterEach(cleanupTmp);

const base = { id: 'my-template', version: '1.2.3', kinds: ['role'], requires: {}, files: [{ kind: 'role', path: 'roles/x.json' }] };
const ok = (v: unknown) => templateSchema.safeParse(v);
const bad = (v: unknown, p: (string | number)[]) => {
  const r = ok(v);
  expect(r.success).toBe(false);
  expect(r.success ? [] : r.error.issues.map((i) => JSON.stringify(i.path))).toContain(JSON.stringify(p));
};

describe('template schema', () => {
  test('valid minimal and typed-params manifests', () => {
    expect(ok(base).success).toBe(true);
    expect(ok({ ...base, params: { type: 'object', required: ['n'], properties: { n: { type: 'string' }, k: { type: 'integer', default: 1 }, m: { type: 'string', enum: ['a', 'b'], default: 'a' } } } }).success).toBe(true);
  });
  test('invalid: bad id, bad semver, unknown key, undeclared kind, escaping path', () => {
    bad({ ...base, id: 'Bad Id' }, ['id']);
    bad({ ...base, version: '1.0' }, ['version']);
    bad({ ...base, surprise: 1 }, []);
    bad({ ...base, kinds: ['team'] }, ['files', 0, 'kind']);
    bad({ ...base, files: [{ kind: 'role', path: '../x.json' }] }, ['files', 0, 'path']);
    bad({ ...base, kinds: ['code'] }, ['kinds', 0]);
  });
  test('invalid params: wrong default type, enum default outside, unknown type, bad pattern, bad name', () => {
    const p = (properties: object, extra: object = {}) => ({ ...base, params: { type: 'object', properties, ...extra } });
    bad(p({ a: { type: 'integer', default: 'x' } }), ['params', 'properties', 'a', 'default']);
    bad(p({ a: { type: 'string', enum: ['x'], default: 'y' } }), ['params', 'properties', 'a', 'default']);
    bad(p({ a: { type: 'array' } }), ['params', 'properties', 'a', 'type']);
    bad(p({ a: { type: 'string', pattern: '(' } }), ['params', 'properties', 'a', 'pattern']);
    bad(p({ 'bad name': { type: 'string' } }), ['params', 'properties', 'bad name']);
    bad(p({}, { required: ['ghost'] }), ['params', 'required', 0]);
  });
});

describe('shipped templates', () => {
  test('the five starter templates exist and every one loads and validates', () => {
    expect(listBuiltinTemplates()).toEqual(['defaults-v1', 'org-full-life', 'roles-content', 'roles-verification', 'team-youtube-channel']);
    for (const id of listBuiltinTemplates()) {
      const t = loadTemplateDir(path.join(BUILTIN_TEMPLATES_DIR, id));
      expect(t.manifest.id).toBe(id);
      expect(t.files.length).toBeGreaterThan(0);
      for (const f of t.files) expect(KIND_TABLE.map((k) => k.kind)).toContain(f.kind);
    }
  });
  test('shipped templates contain no secrets or handles', () => {
    for (const id of listBuiltinTemplates()) {
      const t = loadTemplateDir(path.join(BUILTIN_TEMPLATES_DIR, id));
      const text = JSON.stringify(t.files.map((f) => f.raw));
      expect(text).not.toMatch(/secretRef|"handle"|"profileId"|sk-|-----BEGIN/);
    }
  });
  test('the Owner is never an agent: no agent is named after the owner and the top agent is cos', () => {
    const t = loadTemplateDir(path.join(BUILTIN_TEMPLATES_DIR, 'org-full-life'));
    const agents = t.files.filter((f) => f.kind === 'agent').map((f) => f.raw as { id: string; parentAgentId: string | null });
    expect(agents.filter((a) => a.parentAgentId === null).map((a) => a.id)).toEqual(['cos']);
    expect(agents.map((a) => a.id)).not.toContain('tej');
  });
  test('a template with a bad path, bad JSON or no manifest fails to load with a clear error', () => {
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const m = readJson(path.join(dir, 'template.json'));
    m.files[0].path = '../escape.json';
    writeJson(path.join(dir, 'template.json'), m);
    expect(() => loadTemplateDir(dir)).toThrow('not a valid template');
    fs.writeFileSync(path.join(dir, 'template.json'), '{ nope');
    expect(() => loadTemplateDir(dir)).toThrow('not valid JSON');
    expect(() => loadTemplateDir(path.join(root, 'absent'))).toThrow('no template.json');
  });
});
