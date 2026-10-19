// Config REGISTRY loader (P0-6). Generic over registered config kinds: a kind is DATA (name, Zod schema,
// where its files live, optional semantic check). The loader knows nothing about any particular org.
// - An empty $FLEET_HOME (no files at all) loads with no errors: an empty company is valid (SPEC 26.1).
// - Last-good: a file that fails to parse or validate is rejected with a clear error and the previously
//   loaded version of that object stays active. The first load of a bad file leaves the object absent.
import fs from 'node:fs';
import path from 'node:path';
import { StoreError, readOptional } from '../lib/store.ts';
import { resolveHome } from './home.ts';
import { KIND_TABLE } from './kinds.ts';

export interface ParseSchema<T = unknown> {
  parse(input: unknown): T;
}

export interface CheckContext {
  home: string;
}

export interface KindDef<T = unknown> {
  /** kind name, `[a-z][a-z0-9-]*` (matches ConfigVersion.kind). */
  kind: string;
  schema: ParseSchema<T>;
  /** one file, path relative to $FLEET_HOME; the object id is the kind name. Exactly one of file/dir. */
  file?: string;
  /** a directory of `<id>.json` files (not recursive), relative to $FLEET_HOME. */
  dir?: string;
  /** semantic checks beyond the schema; return one message per problem. */
  check?: (value: T, ctx: CheckContext) => string[] | Promise<string[]>;
}

export interface ConfigIssue {
  kind: string;
  id: string;
  file: string;
  message: string;
  /** true when a previously loaded version stays active. */
  keptLastGood: boolean;
}

export interface LoadResult {
  /** true when there are no issues. */
  ok: boolean;
  issues: ConfigIssue[];
}

export type ReloadStatus = 'loaded' | 'rejected' | 'removed' | 'ignored';
export interface ReloadResult {
  status: ReloadStatus;
  kind?: string;
  id?: string;
  issue?: ConfigIssue;
}

const KIND_RE = /^[a-z][a-z0-9-]*$/;

function describe(e: unknown): string {
  if (e instanceof StoreError) {
    const c = e.cause as { issues?: Array<{ path: PropertyKey[]; message: string }> } | undefined;
    if (e.code === 'validation' && c?.issues?.length) {
      return 'schema validation failed: ' + c.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
    }
    if (e.code === 'bad_json') return `not valid JSON (${e.message})`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export class ConfigRegistry {
  readonly home: string;
  private kinds = new Map<string, KindDef>();
  /** kind -> id -> last-good value */
  private store = new Map<string, Map<string, unknown>>();

  constructor(home?: string, opts: { kinds?: KindDef[] } = {}) {
    const h = resolveHome(home);
    this.home = fs.existsSync(h) ? fs.realpathSync(h) : path.resolve(h);
    for (const k of opts.kinds ?? []) this.registerKind(k);
  }

  registerKind<T>(def: KindDef<T>): void {
    if (!KIND_RE.test(def.kind)) throw new Error(`invalid kind name ${JSON.stringify(def.kind)}`);
    if (!!def.file === !!def.dir) throw new Error(`kind '${def.kind}': set exactly one of file / dir`);
    if (this.kinds.has(def.kind)) throw new Error(`kind '${def.kind}' is already registered`);
    const loc = def.file ?? def.dir!;
    if (loc.startsWith('/') || loc.split('/').includes('..')) throw new Error(`kind '${def.kind}': location must be relative to the home`);
    for (const o of this.kinds.values()) {
      if ((o.file ?? o.dir) === loc) throw new Error(`kind '${def.kind}': location '${loc}' already used by '${o.kind}'`);
    }
    this.kinds.set(def.kind, def as KindDef);
    this.store.set(def.kind, new Map());
  }

  kindNames(): string[] {
    return [...this.kinds.keys()];
  }

  get<T = unknown>(kind: string, id?: string): T | undefined {
    return this.store.get(kind)?.get(id ?? kind) as T | undefined;
  }

  /** All loaded objects of a kind, keyed by id. */
  all<T = unknown>(kind: string): Record<string, T> {
    return Object.fromEntries(this.store.get(kind) ?? []) as Record<string, T>;
  }

  /** Validated config as { kind: { id: value } }. */
  snapshot(): Record<string, Record<string, unknown>> {
    return Object.fromEntries([...this.store].map(([k, m]) => [k, Object.fromEntries(m)]));
  }

  /** Reads every registered location. Missing files/dirs are fine (empty company). */
  async loadAll(): Promise<LoadResult> {
    const issues: ConfigIssue[] = [];
    for (const def of this.kinds.values()) {
      const seen = new Set<string>();
      if (def.file) {
        const r = await this.loadOne(def, def.kind, path.join(this.home, def.file));
        if (r.exists) seen.add(def.kind);
        if (r.issue) issues.push(r.issue);
      } else {
        const dirPath = path.join(this.home, def.dir!);
        for (const name of this.listDir(dirPath)) {
          const id = name.slice(0, -'.json'.length);
          seen.add(id);
          const r = await this.loadOne(def, id, path.join(dirPath, name));
          if (r.issue) issues.push(r.issue);
        }
      }
      // objects whose file is gone are removed (a deleted file is a deliberate change, not a bad one)
      const m = this.store.get(def.kind)!;
      for (const id of [...m.keys()]) if (!seen.has(id)) m.delete(id);
    }
    return { ok: issues.length === 0, issues };
  }

  /** Reloads one changed file (watcher entry point). Unknown paths are ignored. */
  async reloadFile(file: string): Promise<ReloadResult> {
    const abs = this.normalize(file);
    for (const def of this.kinds.values()) {
      let id: string | undefined;
      if (def.file && abs === path.join(this.home, def.file)) id = def.kind;
      else if (def.dir && path.dirname(abs) === path.join(this.home, def.dir) && this.isConfigName(path.basename(abs))) {
        id = path.basename(abs).slice(0, -'.json'.length);
      }
      if (id === undefined) continue;
      const r = await this.loadOne(def, id, abs);
      if (!r.exists) {
        this.store.get(def.kind)!.delete(id);
        return { status: 'removed', kind: def.kind, id };
      }
      return r.issue ? { status: 'rejected', kind: def.kind, id, issue: r.issue } : { status: 'loaded', kind: def.kind, id };
    }
    return { status: 'ignored' };
  }

  private normalize(file: string): string {
    const abs = path.resolve(file);
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }

  private isConfigName(name: string): boolean {
    return name.endsWith('.json') && !name.startsWith('.') && name.length > '.json'.length;
  }

  private listDir(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => (d.isFile() || d.isSymbolicLink()) && this.isConfigName(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async loadOne(def: KindDef, id: string, file: string): Promise<{ exists: boolean; issue?: ConfigIssue }> {
    const m = this.store.get(def.kind)!;
    const fail = (message: string): { exists: boolean; issue: ConfigIssue } => {
      const keptLastGood = m.has(id);
      return { exists: true, issue: { kind: def.kind, id, file, message, keptLastGood } };
    };
    let value: unknown;
    try {
      value = await readOptional(file, def.schema);
    } catch (e) {
      return fail(describe(e));
    }
    if (value === undefined) return { exists: false };
    const objId = (value as { id?: unknown } | null)?.id;
    if (def.dir && typeof objId === 'string' && objId !== id) {
      return fail(`id '${objId}' does not match the file name '${id}.json'`);
    }
    if (def.check) {
      let msgs: string[];
      try {
        msgs = await def.check(value, { home: this.home });
      } catch (e) {
        msgs = [describe(e)];
      }
      if (msgs.length > 0) return fail(msgs.join('; '));
    }
    m.set(id, value);
    return { exists: true };
  }
}

/** Registry with every kind in KIND_TABLE (the kinds P0-2 defines schemas for). */
export function createDefaultRegistry(home?: string): ConfigRegistry {
  const reg = new ConfigRegistry(home);
  for (const k of KIND_TABLE) reg.registerKind(k);
  return reg;
}

