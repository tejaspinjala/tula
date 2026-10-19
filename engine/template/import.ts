// Template import: plan (preview) and apply. Generic over registered config kinds (engine/home/kinds.ts).
// - plan: load packages -> typed params -> `{{param}}` substitution -> validate every object with its kind's
//   schema + semantic check -> reference integrity on (current home + plan) -> diff against the home.
// - diff statuses: added | changed | unchanged | conflict | skipped. An existing, different object is `changed` only
//   if it is byte-for-byte what THIS template installed last time (recorded hashes); anything else is a conflict.
// - apply: refuses while a conflict is unresolved; writes all files through the store, re-validates the whole home
//   with the P0-6 registry, rolls everything back on any failure, then makes ONE git commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, type JsonValue } from '../lib/chain.ts';
import { withLock } from '../lib/lock.ts';
import { resolveInside } from '../lib/paths.ts';
import { write as storeWrite } from '../lib/store.ts';
import { initHome } from '../home/home.ts';
import { KIND_TABLE } from '../home/kinds.ts';
import { createDefaultRegistry, type KindDef } from '../home/registry.ts';
import { realRunner, type Runner } from '../home/run.ts';
import { TemplateError } from './errors.ts';
import { commitFiles, isTracked } from './git.ts';
import { findTemplate, type LoadedTemplate } from './load.ts';
import { placeholders, resolveParams, substitute, type ParamValues } from './params.ts';
import { sha256 } from './util.ts';

export type Status = 'added' | 'changed' | 'unchanged' | 'conflict' | 'skipped';
export type Resolution = 'skip' | 'overwrite';

export interface PlanItem {
  /** config kind, or 'template' for the install record */
  kind: string;
  id: string;
  template: string;
  /** path relative to the home */
  file: string;
  status: Status;
  next: unknown;
  prev?: unknown;
  /** dotted paths that differ (changed / conflict) */
  diff?: string[];
  reason?: string;
}

export interface Plan {
  home: string;
  templates: { id: string; version: string; params: ParamValues }[];
  items: PlanItem[];
  errors: string[];
  counts: Record<Status, number>;
  /** true when apply would write something */
  hasChanges: boolean;
}

export interface ImportOptions {
  home: string;
  /** template ids or directories */
  templates: string[];
  /** extra directories holding `<id>/template.json` packages */
  roots?: string[];
  /** `name` applies to every selected template that declares it; `<templateId>:name` to one template */
  params?: Record<string, unknown>;
  /** `kind/id` -> resolution */
  resolutions?: Record<string, Resolution>;
  onConflict?: Resolution;
  run?: Runner;
}

export const INSTALLED_DIR = 'templates/installed';

const installedSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  objects: z.array(z.strictObject({ kind: z.string(), id: z.string(), sha256: z.string() })),
});
type Installed = z.infer<typeof installedSchema>;

const hashOf = (v: unknown) => sha256(canonicalJson(v as JsonValue));

function kindDef(kind: string): KindDef | undefined {
  return KIND_TABLE.find((k) => k.kind === kind);
}

function fileFor(def: KindDef, id: string): string {
  return def.file ?? `${def.dir}/${id}.json`;
}

function issuesOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (issues?.length) return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message : String(e);
}

function leafPaths(v: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (x: unknown, p: string) => {
    if (Array.isArray(x)) {
      if (x.length === 0) out.set(p, '[]');
      x.forEach((y, i) => walk(y, `${p}[${i}]`));
    } else if (x && typeof x === 'object') {
      const ents = Object.entries(x);
      if (ents.length === 0) out.set(p, '{}');
      for (const [k, y] of ents) walk(y, p ? `${p}.${k}` : k);
    } else out.set(p, JSON.stringify(x));
  };
  walk(v, prefix);
  return out;
}

export function diffPaths(prev: unknown, next: unknown): string[] {
  const a = leafPaths(prev);
  const b = leafPaths(next);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

/** Which fields name other objects, as DATA: [kind, field, target kind, many?]. */
const REFS: { kind: string; field: string; to: string; many?: boolean }[] = [
  { kind: 'department', field: 'directorAgentId', to: 'agent' },
  { kind: 'agent', field: 'roleId', to: 'role' },
  { kind: 'agent', field: 'parentAgentId', to: 'agent' },
  { kind: 'agent', field: 'departmentId', to: 'department' },
  { kind: 'agent', field: 'teamId', to: 'team' },
  { kind: 'team', field: 'departmentId', to: 'department' },
  { kind: 'team', field: 'managerAgentId', to: 'agent' },
  { kind: 'team', field: 'memberAgentIds', to: 'agent', many: true },
  { kind: 'team', field: 'connectionIds', to: 'connection', many: true },
  { kind: 'team', field: 'workflowIds', to: 'workflow', many: true },
  { kind: 'connection', field: 'teamId', to: 'team' },
  { kind: 'connection', field: 'sharedWithTeams', to: 'team', many: true },
];

function referenceIssues(merged: Record<string, Record<string, unknown>>, planned: Set<string>): string[] {
  const out: string[] = [];
  const known = new Set(Object.keys(merged));
  for (const r of REFS) {
    if (!known.has(r.to) || !kindDef(r.to)) continue;
    for (const [id, obj] of Object.entries(merged[r.kind] ?? {})) {
      if (!planned.has(`${r.kind}/${id}`)) continue;
      const v = (obj as Record<string, unknown>)[r.field];
      for (const target of (r.many ? (v as string[] | undefined) ?? [] : v === undefined || v === null ? [] : [v as string])) {
        if (!(target in (merged[r.to] ?? {}))) out.push(`${r.kind}/${id}: ${r.field} refers to ${r.to} '${target}', which does not exist`);
      }
    }
  }
  for (const [id, a] of Object.entries(merged.agent ?? {})) {
    if (!planned.has(`agent/${id}`)) continue;
    const seen = new Set([id]);
    let cur = (a as { parentAgentId: string | null }).parentAgentId;
    while (cur) {
      if (seen.has(cur)) { out.push(`agent/${id}: parent chain contains a cycle at '${cur}'`); break; }
      seen.add(cur);
      cur = (merged.agent?.[cur] as { parentAgentId: string | null } | undefined)?.parentAgentId ?? null;
    }
  }
  return out;
}

function readJsonIfExists(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new TemplateError(`${file} exists but is not valid JSON; fix or remove it before importing`);
  }
}

function splitParams(all: Record<string, unknown>, tpls: LoadedTemplate[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const declared = (t: LoadedTemplate) => Object.keys(((t.manifest.params?.properties ?? {}) as object));
  const usedGlobal = new Set<string>();
  for (const t of tpls) out.set(t.manifest.id, {});
  for (const [k, v] of Object.entries(all)) {
    const colon = k.indexOf(':');
    if (colon > 0) {
      const tid = k.slice(0, colon);
      const name = k.slice(colon + 1);
      const slot = out.get(tid);
      if (!slot) throw new TemplateError(`--param ${k}: template '${tid}' is not part of this import`);
      slot[name] = v;
    } else {
      for (const t of tpls) if (declared(t).includes(k)) { out.get(t.manifest.id)![k] = v; usedGlobal.add(k); }
      if (!tpls.some((t) => declared(t).includes(k))) throw new TemplateError(`param '${k}' is not declared by any selected template`, tpls.map((t) => `${t.manifest.id}: ${declared(t).join(', ') || '(no params)'}`));
    }
  }
  return out;
}

export async function planImport(opts: ImportOptions): Promise<Plan> {
  const home = path.resolve(opts.home);
  const homeExists = fs.existsSync(home);
  const root = homeExists ? fs.realpathSync(home) : home;
  const errors: string[] = [];

  // 1. load packages
  const tpls: LoadedTemplate[] = [];
  for (const ref of opts.templates) {
    const t = findTemplate(ref, opts.roots);
    if (tpls.some((x) => x.manifest.id === t.manifest.id)) continue;
    tpls.push(t);
  }
  if (tpls.length === 0) throw new TemplateError('no templates selected');

  // 2. requires.templates must be selected or already installed
  const selected = new Set(tpls.map((t) => t.manifest.id));
  for (const t of tpls) {
    for (const need of t.manifest.requires.templates ?? []) {
      if (selected.has(need)) continue;
      if (homeExists && fs.existsSync(path.join(root, INSTALLED_DIR, `${need}.json`))) continue;
      errors.push(`template '${t.manifest.id}' requires template '${need}' (import it too, or install it first)`);
    }
  }

  // 3. params + substitution + per-kind validation
  const perTemplate = splitParams(opts.params ?? {}, tpls);
  const checkHome = homeExists ? root : fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-import-check-'));
  const resolved: { kind: string; id: string; template: string; file: string; value: unknown }[] = [];
  const tplParams: Record<string, ParamValues> = {};
  try {
    for (const t of tpls) {
      const id = t.manifest.id;
      const decl = t.manifest.params as Record<string, unknown> | undefined;
      const values = resolveParams(id, decl, perTemplate.get(id)!);
      tplParams[id] = values;
      const declared = new Set(Object.keys((decl?.properties ?? {}) as object));
      for (const f of t.files) {
        for (const name of placeholders(f.raw)) {
          if (!declared.has(name)) errors.push(`${id}/${f.path}: placeholder {{${name}}} is not a declared param`);
        }
        let value: unknown;
        try {
          value = substitute(f.raw, values, `${id}/${f.path}`);
        } catch (e) {
          errors.push((e as Error).message);
          continue;
        }
        const def = kindDef(f.kind);
        if (!def) { errors.push(`${id}/${f.path}: kind '${f.kind}' is not a registered config kind`); continue; }
        let parsed: unknown;
        try {
          parsed = def.schema.parse(value);
        } catch (e) {
          errors.push(`${id}/${f.path} (${f.kind}): ${issuesOf(e)}`);
          continue;
        }
        const oid = def.file ? def.kind : (parsed as { id: string }).id;
        if (def.check) {
          try {
            const msgs = await def.check(parsed, { home: checkHome });
            for (const m of msgs) errors.push(`${id}/${f.path} (${f.kind}/${oid}): ${m}`);
            if (msgs.length) continue;
          } catch (e) {
            errors.push(`${id}/${f.path} (${f.kind}/${oid}): ${issuesOf(e)}`);
            continue;
          }
        }
        resolved.push({ kind: f.kind, id: oid, template: id, file: fileFor(def, oid), value: parsed });
      }
    }
  } finally {
    if (!homeExists) fs.rmSync(checkHome, { recursive: true, force: true });
  }

  // 4. duplicates across (and inside) templates
  const byKey = new Map<string, (typeof resolved)[number]>();
  const objs: typeof resolved = [];
  for (const o of resolved) {
    const key = `${o.kind}/${o.id}`;
    const prev = byKey.get(key);
    if (prev) {
      if (hashOf(prev.value) !== hashOf(o.value)) errors.push(`${key} is defined by both '${prev.template}' and '${o.template}' with different content`);
      continue;
    }
    byKey.set(key, o);
    objs.push(o);
  }

  // 5. diff against the home
  const items: PlanItem[] = [];
  const reg = createDefaultRegistry(root);
  if (homeExists) await reg.loadAll();
  for (const o of objs) {
    const abs = path.join(root, o.file);
    const existingRaw = homeExists ? readJsonIfExists(abs) : undefined;
    const def = kindDef(o.kind)!;
    let prev: unknown;
    if (existingRaw !== undefined) {
      // compare in the schema's normal form so key order / defaults do not matter
      try { prev = def.schema.parse(existingRaw); } catch { prev = existingRaw; }
    }
    const item: PlanItem = { kind: o.kind, id: o.id, template: o.template, file: o.file, status: 'added', next: o.value };
    if (prev !== undefined) {
      item.prev = prev;
      if (hashOf(prev) === hashOf(o.value)) item.status = 'unchanged';
      else {
        item.diff = diffPaths(prev, o.value);
        const rec = homeExists ? (readJsonIfExists(path.join(root, INSTALLED_DIR, `${o.template}.json`)) as Installed | undefined) : undefined;
        const base = rec?.objects?.find((x) => x.kind === o.kind && x.id === o.id)?.sha256;
        if (base && base === hashOf(prev)) item.status = 'changed';
        else {
          item.status = 'conflict';
          item.reason = base ? 'edited since the template installed it' : 'already exists and was not installed by this template';
          const res = opts.resolutions?.[`${o.kind}/${o.id}`] ?? opts.onConflict;
          if (res === 'overwrite') { item.status = 'changed'; item.reason = `${item.reason} (overwrite requested)`; }
          else if (res === 'skip') { item.status = 'skipped'; }
        }
      }
    }
    items.push(item);
  }

  // 6. reference integrity on (home + plan)
  const merged: Record<string, Record<string, unknown>> = homeExists ? reg.snapshot() : {};
  for (const k of KIND_TABLE) merged[k.kind] ??= {};
  const planned = new Set<string>();
  for (const it of items) {
    if (it.status === 'skipped' || it.status === 'conflict') continue;
    (merged[it.kind] ??= {})[it.id] = it.next;
    planned.add(`${it.kind}/${it.id}`);
  }
  errors.push(...referenceIssues(merged, planned));

  // 7. install records
  for (const t of tpls) {
    const id = t.manifest.id;
    const prevRec = homeExists ? (readJsonIfExists(path.join(root, INSTALLED_DIR, `${id}.json`)) as Installed | undefined) : undefined;
    const mine = items.filter((i) => i.template === id);
    const objects = mine
      .filter((i) => i.status !== 'conflict')
      .map((i) => {
        if (i.status === 'skipped') {
          const old = prevRec?.objects?.find((x) => x.kind === i.kind && x.id === i.id);
          return old ?? null;
        }
        return { kind: i.kind, id: i.id, sha256: hashOf(i.next) };
      })
      .filter((x): x is { kind: string; id: string; sha256: string } => x !== null)
      .sort((a, b) => (a.kind + '/' + a.id).localeCompare(b.kind + '/' + b.id));
    const rec: Installed = { id, version: t.manifest.version, params: tplParams[id] ?? {}, objects };
    const file = `${INSTALLED_DIR}/${id}.json`;
    const item: PlanItem = { kind: 'template', id, template: id, file, status: 'added', next: rec };
    if (prevRec !== undefined) {
      item.prev = prevRec;
      if (hashOf(prevRec) === hashOf(rec)) item.status = 'unchanged';
      else { item.status = 'changed'; item.diff = diffPaths(prevRec, rec); }
    }
    items.push(item);
  }

  const counts: Record<Status, number> = { added: 0, changed: 0, unchanged: 0, conflict: 0, skipped: 0 };
  for (const i of items) counts[i.status]++;
  return {
    home: root,
    templates: tpls.map((t) => ({ id: t.manifest.id, version: t.manifest.version, params: tplParams[t.manifest.id] ?? {} })),
    items,
    errors,
    counts,
    hasChanges: counts.added + counts.changed > 0,
  };
}

export function formatPlan(plan: Plan, verbose = false): string {
  const lines: string[] = [];
  lines.push(`home: ${plan.home}`);
  lines.push(`templates: ${plan.templates.map((t) => `${t.id}@${t.version}`).join(', ')}`);
  const mark: Record<Status, string> = { added: '+', changed: '~', unchanged: '=', conflict: '!', skipped: '-' };
  for (const i of plan.items) {
    if (i.status === 'unchanged' && !verbose) continue;
    const label = i.kind === 'template' ? `template/${i.id}` : `${i.kind}/${i.id}`;
    const extra = i.status === 'conflict' || i.status === 'skipped' ? ` ${i.status.toUpperCase()}: ${i.reason ?? ''}` : '';
    const d = i.diff?.length ? `  [${i.diff.slice(0, 6).join(', ')}${i.diff.length > 6 ? `, +${i.diff.length - 6} more` : ''}]` : '';
    lines.push(`  ${mark[i.status]} ${label}${extra}${d}`);
  }
  for (const e of plan.errors) lines.push(`  error: ${e}`);
  const c = plan.counts;
  if (!plan.hasChanges && c.conflict === 0 && plan.errors.length === 0) lines.push('no changes');
  lines.push(`summary: ${c.added} added, ${c.changed} changed, ${c.unchanged} unchanged, ${c.conflict} conflict${c.conflict === 1 ? '' : 's'}${c.skipped ? `, ${c.skipped} skipped` : ''}`);
  if (c.conflict) lines.push('conflicts block --apply: resolve with --resolve <kind>/<id>=skip|overwrite or --on-conflict skip|overwrite');
  return lines.join('\n');
}

export interface ApplyResult {
  commit?: string;
  written: string[];
}

export async function applyPlan(plan: Plan, opts: { run?: Runner; message?: string } = {}): Promise<ApplyResult> {
  const run = opts.run ?? realRunner;
  if (plan.errors.length) throw new TemplateError('plan has errors; nothing applied', plan.errors);
  if (plan.counts.conflict) {
    throw new TemplateError('plan has unresolved conflicts; nothing applied', plan.items.filter((i) => i.status === 'conflict').map((i) => `${i.kind}/${i.id}: ${i.reason}`));
  }
  const writes = plan.items.filter((i) => i.status === 'added' || i.status === 'changed');
  if (writes.length === 0) return { written: [] };

  initHome({ home: plan.home, run });
  const home = fs.realpathSync(plan.home);
  const lockFile = path.join(home, 'state', 'template-import');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  return withLock(lockFile, async () => {
    const backups = new Map<string, Buffer | null>();
    const rollback = () => {
      for (const [file, bytes] of backups) {
        try {
          if (bytes === null) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, bytes);
        } catch { /* best effort; the home is a git repo, `git status` shows leftovers */ }
      }
    };
    const rels: string[] = [];
    try {
      for (const it of writes) {
        const abs = resolveInside(home, it.file);
        backups.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
        const schema = it.kind === 'template' ? installedSchema : kindDef(it.kind)!.schema;
        await storeWrite(abs, it.next, schema);
        rels.push(it.file);
      }
      // P0-6 registry validation of the real result: no written object may be rejected
      const reg = createDefaultRegistry(home);
      const res = await reg.loadAll();
      const wrote = new Set(writes.filter((w) => w.kind !== 'template').map((w) => path.join(home, w.file)));
      const bad = res.issues.filter((i) => wrote.has(i.file));
      if (bad.length) throw new TemplateError('registry rejected the imported config; rolled back', bad.map((b) => `${b.kind}/${b.id}: ${b.message}`));
      const toCommit = [...rels];
      if (!isTracked(home, '.gitignore', run) && fs.existsSync(path.join(home, '.gitignore'))) toCommit.push('.gitignore');
      const msg = opts.message ?? `template import: ${plan.templates.map((t) => `${t.id}@${t.version}`).join(', ')}\n\n${writes.filter((w) => w.kind !== 'template').length} object(s) written`;
      const commit = commitFiles(home, toCommit, msg, run);
      return { commit, written: rels };
    } catch (e) {
      rollback();
      throw e;
    }
  });
}
