// Loads tests/fixtures/schema/<entity>/{valid,invalid}-*.json. Invalid fixtures carry `_why` (the rule they
// break) and `_path` (the Zod issue path expected for that rule); both are stripped before parsing.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../helpers.ts';

export const FIXTURE_ROOT = path.join(repoRoot, 'tests', 'fixtures', 'schema');

export interface Fixture {
  entity: string;
  file: string;
  kind: 'valid' | 'invalid';
  data: unknown;
  why?: string;
  path?: (string | number)[];
}

export function loadFixtures(entity: string): Fixture[] {
  const dir = path.join(FIXTURE_ROOT, entity);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
      const kind = file.startsWith('valid-') ? 'valid' : file.startsWith('invalid-') ? 'invalid' : null;
      if (!kind) throw new Error(`${entity}/${file}: fixture names start with valid- or invalid-`);
      const { _why, _path, ...data } = raw;
      return { entity, file, kind, data, why: _why as string | undefined, path: _path as (string | number)[] | undefined };
    });
}

export function fixtureEntities(): string[] {
  return fs.readdirSync(FIXTURE_ROOT).filter((d) => fs.statSync(path.join(FIXTURE_ROOT, d)).isDirectory()).sort();
}
