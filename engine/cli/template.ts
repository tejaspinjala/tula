#!/usr/bin/env bun
// fleet template ... : import / export / list. All logic lives in engine/template/; this file parses argv.
//   bun run template import <ids...> [--home DIR] [--preview | --apply] [--param k=v]... [--answers FILE.json]
//        [--templates-dir DIR]... [--resolve kind/id=skip|overwrite]... [--on-conflict skip|overwrite] [--json] [--verbose]
//   bun run template export <id> --out DIR [--home DIR] [--version X] [--title T] [--description D] [--kind K]... [--only kind/id]...
//   bun run template list [--templates-dir DIR]...
// Exit: 0 ok (incl. "no changes" and preview with conflicts), 1 refused/failed (conflicts or errors on --apply), 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fleetHome } from '../lib/paths.ts';
import { TemplateError } from '../template/errors.ts';
import { exportTemplate } from '../template/export.ts';
import { applyPlan, formatPlan, planImport, type Resolution } from '../template/import.ts';
import { listBuiltinTemplates } from '../template/load.ts';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `usage:
  template import <ids...> [--home DIR] [--preview|--apply] [--param k=v]... [--answers FILE] [--templates-dir DIR]...
                           [--resolve kind/id=skip|overwrite]... [--on-conflict skip|overwrite] [--json] [--verbose]
  template export <id> --out DIR [--home DIR] [--version X] [--title T] [--description D] [--kind K]... [--only kind/id]...
  template list [--templates-dir DIR]...`;

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

function parse(argv: string[], valued: string[], boolean: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolean.includes(name)) bools.add(name);
      else if (valued.includes(name)) {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        flags.set(name, [...(flags.get(name) ?? []), v]);
      } else throw new UsageError(`unknown option ${a}`);
    } else positional.push(a);
  }
  return { positional, flags, bools };
}

const one = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1);

function parseKv(items: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    const eq = it.indexOf('=');
    if (eq <= 0) throw new UsageError(`${flag} expects key=value, got '${it}'`);
    out[it.slice(0, eq)] = it.slice(eq + 1);
  }
  return out;
}

function readAnswers(file: string): { params: Record<string, unknown>; resolutions: Record<string, Resolution> } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read answers file ${file}: ${(e as Error).message}`);
  }
  const o = raw as { params?: Record<string, unknown>; resolutions?: Record<string, Resolution> };
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => k !== 'params' && k !== 'resolutions')) {
    throw new UsageError('answers file must be {"params": {...}, "resolutions": {...}}');
  }
  return { params: o.params ?? {}, resolutions: o.resolutions ?? {} };
}

const asResolution = (v: string, what: string): Resolution => {
  if (v !== 'skip' && v !== 'overwrite') throw new UsageError(`${what}: expected skip or overwrite, got '${v}'`);
  return v;
};

export async function main(argv: string[], io: Io = { out: console.log, err: console.error }): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === 'import') {
      const p = parse(rest, ['home', 'param', 'answers', 'templates-dir', 'resolve', 'on-conflict'], ['preview', 'apply', 'json', 'verbose']);
      if (p.bools.has('preview') && p.bools.has('apply')) throw new UsageError('choose --preview or --apply, not both');
      if (p.positional.length === 0) throw new UsageError('import needs at least one template id');
      const answers = one(p, 'answers') ? readAnswers(one(p, 'answers')!) : { params: {}, resolutions: {} };
      const params = { ...answers.params, ...parseKv(p.flags.get('param') ?? [], '--param') };
      const resolutions: Record<string, Resolution> = { ...answers.resolutions };
      for (const [k, v] of Object.entries(parseKv(p.flags.get('resolve') ?? [], '--resolve'))) resolutions[k] = asResolution(v, `--resolve ${k}`);
      const onConflict = one(p, 'on-conflict') ? asResolution(one(p, 'on-conflict')!, '--on-conflict') : undefined;
      const plan = await planImport({
        home: path.resolve(one(p, 'home') ?? fleetHome()),
        templates: p.positional,
        roots: p.flags.get('templates-dir'),
        params,
        resolutions,
        onConflict,
      });
      const apply = p.bools.has('apply');
      let result: Awaited<ReturnType<typeof applyPlan>> | undefined;
      let failure: string | undefined;
      if (apply) {
        try {
          result = await applyPlan(plan);
        } catch (e) {
          failure = (e as Error).message;
        }
      }
      if (p.bools.has('json')) {
        io.out(JSON.stringify({ applied: !!result && result.written.length > 0, commit: result?.commit, counts: plan.counts, errors: plan.errors, failure, items: plan.items.map(({ kind, id, template, file, status, diff, reason }) => ({ kind, id, template, file, status, diff, reason })) }, null, 2));
      } else {
        io.out(formatPlan(plan, p.bools.has('verbose')));
        if (apply && !failure) io.out(result?.commit ? `applied: commit ${result.commit.slice(0, 12)} (${result.written.length} file(s))` : 'nothing to apply');
        if (!apply) io.out('preview only: nothing written. Re-run with --apply to write.');
      }
      if (failure) {
        io.err(`refused: ${failure}`);
        return 1;
      }
      if (plan.errors.length && !apply) return 1;
      return 0;
    }
    if (cmd === 'export') {
      const p = parse(rest, ['home', 'out', 'version', 'title', 'description', 'kind', 'only'], []);
      const id = p.positional[0];
      if (!id || p.positional.length > 1) throw new UsageError('export needs exactly one template id');
      const outDir = one(p, 'out');
      if (!outDir) throw new UsageError('export needs --out DIR');
      const r = await exportTemplate({
        home: path.resolve(one(p, 'home') ?? fleetHome()),
        id,
        outDir,
        version: one(p, 'version'),
        title: one(p, 'title'),
        description: one(p, 'description'),
        kinds: p.flags.get('kind'),
        only: p.flags.get('only'),
      });
      io.out(`exported ${r.objects.length} object(s) to ${r.dir}`);
      for (const s of r.skipped) io.out(`  skipped ${s}`);
      for (const s of r.redactions) io.out(`  redacted ${s}`);
      return 0;
    }
    if (cmd === 'list') {
      const p = parse(rest, ['templates-dir'], []);
      for (const id of listBuiltinTemplates(p.flags.get('templates-dir'))) io.out(id);
      return 0;
    }
    throw new UsageError(cmd ? `unknown command '${cmd}'` : 'missing command');
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof TemplateError) {
      io.err(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
