// Template export: turns the current config of a $FLEET_HOME into a template package, STRIPPING what must never
// leave the home (SPEC 26.6): secret refs and values, account handles/ids/urls, browser profile ids, health data,
// local run/task ids, and anything that lives under private/ (or exec/, brain/private/).
import fs from 'node:fs';
import path from 'node:path';
import { containsSecretValue, looksLikeOpaqueToken } from '../schema/common.ts';
import { TEMPLATE_KINDS, templateSchema } from '../schema/template.ts';
import { KIND_TABLE } from '../home/kinds.ts';
import { createDefaultRegistry } from '../home/registry.ts';
import { TemplateError } from './errors.ts';
import { loadTemplateDir } from './load.ts';

export const REDACTED = '<redacted>';
const PRIVATE_DIRS = ['private', 'exec', 'brain/private'];

export interface ExportOptions {
  home: string;
  id: string;
  outDir: string;
  version?: string;
  title?: string;
  description?: string;
  /** limit to these kinds (default: every template kind present) */
  kinds?: string[];
  /** limit to these `kind/id` objects */
  only?: string[];
}

export interface ExportResult {
  dir: string;
  objects: string[];
  skipped: string[];
  redactions: string[];
}

type Obj = Record<string, unknown>;

/** Deep copy replacing any string that looks like credential material. Records where it happened. */
function redactDeep(v: unknown, where: string, hits: string[]): unknown {
  if (typeof v === 'string') {
    if (containsSecretValue(v) || looksLikeOpaqueToken(v)) {
      hits.push(where);
      return REDACTED;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => redactDeep(x, `${where}[${i}]`, hits));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, `${where}.${k}`, hits)]));
  return v;
}

/** Per-kind structural stripping. Returns a new object. */
function strip(kind: string, value: Obj): Obj {
  const v = structuredClone(value);
  if (kind === 'connection') {
    const account = (v.account ?? {}) as Obj;
    const handle = typeof account.handle === 'string' ? account.handle : undefined;
    let displayName = String(account.displayName ?? v.id);
    if (handle && displayName.toLowerCase().includes(handle.toLowerCase().replace(/^@/, ''))) displayName = String(v.id);
    v.account = { displayName, owner: account.owner };
    const auth = (v.auth ?? {}) as Obj;
    v.auth = { mode: auth.mode };
    delete v.config;
    delete v.health;
    delete v.tosAcknowledgedAt;
    delete v.sharedWithTeams;
    const posting = (v.posting ?? {}) as Obj;
    v.posting = { ...posting, mode: 'manual' };
    v.status = 'pending_confirmation';
  } else if (kind === 'providers') {
    const providers = (v.providers ?? {}) as Record<string, Obj>;
    for (const p of Object.values(providers)) delete p.secretRef;
  } else if (kind === 'agent') {
    delete v.coachingNoteIds;
    delete v.projectId;
  }
  return v;
}

function underPrivate(home: string, abs: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return false;
  }
  return PRIVATE_DIRS.some((d) => {
    const p = path.join(home, d);
    return real === p || real.startsWith(p + path.sep);
  });
}

export async function exportTemplate(opts: ExportOptions): Promise<ExportResult> {
  if (!fs.existsSync(opts.home)) throw new TemplateError(`home ${opts.home} does not exist`);
  const home = fs.realpathSync(opts.home);
  const reg = createDefaultRegistry(home);
  await reg.loadAll();
  const snap = reg.snapshot();
  const allowed = new Set<string>(TEMPLATE_KINDS);
  const kinds = (opts.kinds ?? KIND_TABLE.map((k) => k.kind)).filter((k) => allowed.has(k) && KIND_TABLE.some((d) => d.kind === k));
  for (const k of opts.kinds ?? []) if (!kinds.includes(k)) throw new TemplateError(`kind '${k}' can not be exported`);
  const only = opts.only ? new Set(opts.only) : undefined;

  const skipped: string[] = [];
  const redactions: string[] = [];
  const files: { kind: string; path: string; value: unknown }[] = [];
  for (const kind of kinds) {
    const def = KIND_TABLE.find((d) => d.kind === kind)!;
    for (const [id, value] of Object.entries(snap[kind] ?? {})) {
      if (only && !only.has(`${kind}/${id}`)) continue;
      const src = path.join(home, def.file ?? `${def.dir}/${id}.json`);
      if (underPrivate(home, src)) {
        skipped.push(`${kind}/${id} (under private/)`);
        continue;
      }
      const clean = redactDeep(strip(kind, value as Obj), `${kind}/${id}`, redactions);
      files.push({ kind, path: `objects/${kind}/${id}.json`, value: clean });
    }
  }
  if (only) for (const o of only) if (!files.some((f) => `${f.kind}/${path.basename(f.path, '.json')}` === o)) throw new TemplateError(`${o} not found in ${home}`);
  if (files.length === 0) throw new TemplateError('nothing to export');

  const out = path.resolve(opts.outDir);
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new TemplateError(`${out} is not empty`);
  const present = [...new Set(files.map((f) => f.kind))];
  const manifest = {
    id: opts.id,
    version: opts.version ?? '1.0.0',
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    kinds: present,
    requires: {},
    files: files.map((f) => ({ kind: f.kind, path: f.path })),
  };
  const checked = templateSchema.safeParse(manifest);
  if (!checked.success) throw new TemplateError('export would not be a valid template', checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  for (const f of files) {
    const abs = path.join(out, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(f.value, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(out, 'template.json'), JSON.stringify(manifest, null, 2) + '\n');
  loadTemplateDir(out); // re-read what we wrote
  return { dir: out, objects: files.map((f) => `${f.kind}/${path.basename(f.path, '.json')}`), skipped, redactions };
}
