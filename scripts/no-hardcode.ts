#!/usr/bin/env bun
// No-hardcode lint (C17): engine code must not contain ids from the shipped templates. The forbidden list is
// DERIVED from engine/templates/**: template ids plus the `id` of every object they define (departments, teams,
// roles, agents, connections...). Orgs are data; code that names one is a bug.
//   bun scripts/no-hardcode.ts [--root DIR]      exit 0 clean, 1 violations, 2 usage
// Scope: code files (.ts .tsx .js .mjs .cjs .sh) under engine/ and scripts/, except engine/templates/. Tests and
// docs are not scanned. A line may opt out with the marker `no-hardcode-ok` (say why next to it).
// Matching: an id with a dash is flagged anywhere in the text; a single-word id only when it is a whole quoted
// string literal, so ordinary prose and identifiers never trip it. Single-word ids are not checked inside
// engine/schema/ (that folder defines the shared vocabulary: node types, evidence kinds...).
import fs from 'node:fs';
import path from 'node:path';

export const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);
export const SCAN_DIRS = ['engine', 'scripts'];
export const OPT_OUT = 'no-hardcode-ok';

export interface Violation {
  file: string;
  line: number;
  id: string;
  text: string;
}

function walk(dir: string, skip: (abs: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, d.name);
    if (skip(abs) || d.name === 'node_modules' || d.name === '.git') continue;
    if (d.isDirectory()) walk(abs, skip, out);
    else if (d.isFile()) out.push(abs);
  }
  return out;
}

/** Every template id and every object id defined by the packages under `templatesDir`. */
export function forbiddenIds(templatesDir: string): Map<string, string> {
  const ids = new Map<string, string>(); // id -> where it comes from
  if (!fs.existsSync(templatesDir)) return ids;
  for (const d of fs.readdirSync(templatesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const root = path.join(templatesDir, d.name);
    ids.set(d.name, `template ${d.name}`);
    for (const f of walk(root, () => false)) {
      if (!f.endsWith('.json')) continue;
      let v: unknown;
      try {
        v = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      const id = (v as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.length >= 2 && !id.includes('{{')) ids.set(id, `${d.name}/${path.relative(root, f)}`);
    }
  }
  return ids;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matcherFor(id: string): RegExp {
  return id.includes('-')
    ? new RegExp(`(?<![A-Za-z0-9_-])${esc(id)}(?![A-Za-z0-9_-])`)
    : new RegExp(`(['"\`])${esc(id)}\\1`);
}

export function scan(root: string): Violation[] {
  const templatesDir = path.join(root, 'engine', 'templates');
  const ids = forbiddenIds(templatesDir);
  const matchers = [...ids.keys()].map((id) => ({ id, re: matcherFor(id) }));
  const out: Violation[] = [];
  const skip = (abs: string) => abs === templatesDir;
  for (const top of SCAN_DIRS) {
    for (const file of walk(path.join(root, top), skip)) {
      if (!CODE_EXT.has(path.extname(file)) || file.endsWith('.d.ts')) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
        if (text.includes(OPT_OUT)) return;
        const vocab = path.relative(root, file).startsWith(path.join('engine', 'schema') + path.sep);
        for (const m of matchers) if (!(vocab && !m.id.includes('-')) && m.re.test(text)) out.push({ file: path.relative(root, file), line: i + 1, id: m.id, text: text.trim().slice(0, 120) });
      });
    }
  }
  return out;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const known = a.filter((x) => x.startsWith('--') && x !== '--root');
  const ri = a.indexOf('--root');
  if (known.length || (ri >= 0 && !a[ri + 1])) {
    console.error('usage: no-hardcode.ts [--root DIR]');
    process.exit(2);
  }
  const root = path.resolve(ri >= 0 ? a[ri + 1]! : path.join(import.meta.dir, '..'));
  const v = scan(root);
  if (v.length) {
    for (const x of v) console.error(`${x.file}:${x.line}: hard-coded id '${x.id}': ${x.text}`);
    console.error(`${v.length} violation(s): org/template ids belong in engine/templates (data), not in code.`);
    process.exit(1);
  }
  console.log(`no-hardcode: clean (${forbiddenIds(path.join(root, 'engine', 'templates')).size} ids checked)`);
}
