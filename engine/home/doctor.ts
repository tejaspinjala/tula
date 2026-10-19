// `fleet doctor` checks (SPEC 11, 21 P0-6, phase 0 accept: fails on an unencrypted disk). Read-only: it
// creates nothing. Every external dependency (commands, platform, env, bun version) is injectable.
import fs from 'node:fs';
import path from 'node:path';
import { verify } from '../lib/chain.ts';
import { MUST_IGNORE, resolveHome } from './home.ts';
import { ageInstalled, IDENTITY_FILE } from './keys.ts';
import { createDefaultRegistry } from './registry.ts';
import { realRunner, type Runner } from './run.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorDeps {
  home?: string;
  run?: Runner;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  bunVersion?: string;
}

export const MIN_BUN = '1.1.0';
const SECRET_ENV_RE = /(^|_)(API_KEY|APIKEY|SECRET|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|PASSWORD|PRIVATE_KEY)$/i;

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

interface LsblkNode {
  name?: string;
  type?: string;
  mountpoint?: string | null;
  mountpoints?: Array<string | null>;
  children?: LsblkNode[];
}

/** In `lsblk -s` output children are the underlying devices, so "encrypted" = a crypt node at or below. */
function hasCrypt(n: LsblkNode): boolean {
  return n.type === 'crypt' || (n.children ?? []).some(hasCrypt);
}
function mounts(n: LsblkNode): string[] {
  return [...(n.mountpoints ?? []), n.mountpoint ?? null].filter((m): m is string => !!m);
}
function walk(nodes: LsblkNode[], f: (n: LsblkNode) => void): void {
  for (const n of nodes) {
    f(n);
    walk(n.children ?? [], f);
  }
}

export function diskEncryptionCheck(home: string, run: Runner, platform: NodeJS.Platform): Check {
  const name = 'disk encryption';
  if (platform === 'darwin') {
    const r = run('fdesetup', ['status']);
    if (r.missing || r.code !== 0) return { name, status: 'warn', detail: `cannot determine FileVault state (fdesetup: ${r.stderr.trim() || 'failed'})` };
    if (/FileVault is On/i.test(r.stdout)) return { name, status: 'pass', detail: 'FileVault is On' };
    if (/FileVault is Off/i.test(r.stdout)) return { name, status: 'fail', detail: 'FileVault is Off: enable disk encryption before storing private data' };
    return { name, status: 'warn', detail: `unrecognised fdesetup output: ${r.stdout.trim().slice(0, 80)}` };
  }
  if (platform === 'linux') {
    const r = run('lsblk', ['-s', '-J', '-o', 'NAME,TYPE,MOUNTPOINTS']);
    if (r.missing || r.code !== 0) return { name, status: 'warn', detail: 'cannot determine LUKS state (lsblk unavailable)' };
    let tree: LsblkNode[];
    try {
      tree = (JSON.parse(r.stdout) as { blockdevices: LsblkNode[] }).blockdevices ?? [];
    } catch {
      return { name, status: 'warn', detail: 'cannot parse lsblk output' };
    }
    let best: { mp: string; node: LsblkNode } | undefined;
    walk(tree, (n) => {
      for (const mp of mounts(n)) {
        const covers = home === mp || home.startsWith(mp.endsWith('/') ? mp : mp + '/');
        if (covers && (!best || mp.length > best.mp.length)) best = { mp, node: n };
      }
    });
    if (!best) return { name, status: 'warn', detail: 'no block device found for the home directory (container or network filesystem?)' };
    const b: { mp: string; node: LsblkNode } = best;
    return hasCrypt(b.node)
      ? { name, status: 'pass', detail: `${b.mp} is on an encrypted (crypt) device` }
      : { name, status: 'fail', detail: `${b.mp} is not on an encrypted device: enable LUKS/full-disk encryption before storing private data` };
  }
  return { name, status: 'warn', detail: `unknown platform '${platform}': cannot check disk encryption` };
}

function listJsonl(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const run = deps.run ?? realRunner;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });

  let home: string;
  try {
    home = resolveHome(deps.home);
  } catch (e) {
    add('home exists', 'fail', (e as Error).message);
    return checks;
  }
  const exists = fs.existsSync(home) && fs.statSync(home).isDirectory();
  if (exists) home = fs.realpathSync(home);
  add('home exists', exists ? 'pass' : 'fail', exists ? home : `${home} does not exist: run init`);

  if (exists) {
    const isRepo = fs.existsSync(path.join(home, '.git', 'HEAD'));
    add('home is a git repo', isRepo ? 'pass' : 'fail', isRepo ? 'ok' : 'no .git: home must be a git repo (A8); run init');

    const gi = path.join(home, '.gitignore');
    const lines = new Set(fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8').split(/\r?\n/).map((l) => l.trim()) : []);
    const missing = MUST_IGNORE.filter((l) => !lines.has(l));
    add('.gitignore excludes private/ and exec/', missing.length ? 'fail' : 'pass', missing.length ? `missing: ${missing.join(', ')}` : 'ok');

    const reg = createDefaultRegistry(home);
    const res = await reg.loadAll();
    add('config validates', res.ok ? 'pass' : 'fail', res.ok ? 'ok' : res.issues.map((i) => `${i.kind}/${i.id}: ${i.message}`).join(' | '));

    const priv = path.join(home, 'private');
    try {
      const mode = fs.statSync(priv).mode & 0o777;
      add('private/ mode 0700', (mode & 0o077) === 0 ? 'pass' : 'fail', `mode is ${mode.toString(8).padStart(4, '0')}`);
    } catch {
      add('private/ mode 0700', 'fail', 'private/ is missing: run init');
    }

    const idFile = path.join(home, IDENTITY_FILE);
    if (fs.existsSync(idFile)) {
      const mode = fs.statSync(idFile).mode & 0o777;
      add('age identity file mode 0600', (mode & 0o077) === 0 ? 'pass' : 'fail', `mode is ${mode.toString(8).padStart(4, '0')}`);
    }
  }

  checks.push(diskEncryptionCheck(exists ? home : (deps.home ?? ''), run, platform));

  const haveAge = ageInstalled(run);
  add('age installed', haveAge ? 'pass' : 'warn', haveAge ? 'age and age-keygen found' : 'age / age-keygen not installed: private notes cannot be encrypted (install age, then `keys init`)');
  if (haveAge && exists && !fs.existsSync(path.join(home, IDENTITY_FILE))) {
    add('age identity', 'warn', 'no identity yet: run `keys init`');
  }

  const bunV = deps.bunVersion ?? Bun.version;
  add('bun version', versionAtLeast(bunV, MIN_BUN) ? 'pass' : 'fail', `${bunV} (need >= ${MIN_BUN})`);

  const leaked = Object.keys(env).filter((k) => SECRET_ENV_RE.test(k) && (env[k] ?? '') !== '');
  add('no secrets in env', leaked.length ? 'warn' : 'pass', leaked.length ? `set: ${leaked.sort().join(', ')} (names only; keep secrets in Infisical, not the environment)` : 'ok');

  if (exists) {
    const files = [...listJsonl(path.join(home, 'audit')), ...listJsonl(path.join(home, 'approvals'))];
    const bad: string[] = [];
    let total = 0;
    for (const f of files) {
      const v = verify(f);
      if (v.ok) total += v.count;
      else bad.push(`${path.relative(home, f)} (seq ${v.atSeq}: ${v.reason})`);
    }
    add('audit chains verify', bad.length ? 'fail' : 'pass', bad.length ? bad.join('; ') : `${files.length} file(s), ${total} entries`);
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}`).join('\n');
}
export const doctorExitCode = (checks: Check[]): number => (checks.some((c) => c.status === 'fail') ? 1 : 0);
