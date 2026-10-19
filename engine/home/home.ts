// $FLEET_HOME: resolution, directory layout, .gitignore, git init (SPEC section 5 / 17, assumption A8).
// initHome() is idempotent and never writes secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fleetHome, resolveInside } from '../lib/paths.ts';
import { realRunner, type Runner } from './run.ts';

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HomeError';
  }
}

/** Directory layout under $FLEET_HOME (SPEC 17 + PHASE-1-PLAN 1). `mode` is set explicitly (umask-proof). */
export const HOME_DIRS: ReadonlyArray<{ dir: string; mode?: number }> = [
  { dir: 'org/departments' },
  { dir: 'org/teams' },
  { dir: 'org/roles' },
  { dir: 'org/agents' },
  { dir: 'org/schedules' },
  { dir: 'workflows/instances' },
  { dir: 'connections' },
  { dir: 'templates/installed' },
  { dir: 'brain/raw' },
  { dir: 'brain/wiki' },
  { dir: 'brain/private' },
  { dir: 'brain/decisions' },
  { dir: 'brain/diagrams' },
  { dir: 'tasks' },
  { dir: 'runs' },
  { dir: 'meetings' },
  { dir: 'ledger' },
  { dir: 'approvals' },
  { dir: 'grants' },
  { dir: 'audit' },
  { dir: 'staging' },
  { dir: 'evals/golden' },
  { dir: 'evals/hidden' },
  { dir: 'state' },
  { dir: 'private', mode: 0o700 },
  { dir: 'exec', mode: 0o700 },
];

/** Lines init guarantees in .gitignore. private/ and exec/ are never committed (A8). */
export const REQUIRED_GITIGNORE = [
  'private/',
  'exec/',
  'brain/private/',
  'state/',
  'host.json',
  'STOP',
  '*.lock',
  '*.lock.break',
  '.*.tmp-*',
] as const;
/** The subset doctor treats as mandatory. */
export const MUST_IGNORE = ['private/', 'exec/'] as const;

export function resolveHome(home?: string): string {
  return home ?? fleetHome();
}

export interface InitResult {
  home: string;
  createdHome: boolean;
  gitInitialized: boolean;
  gitignoreChanged: boolean;
}

export function initHome(opts: { home?: string; run?: Runner } = {}): InitResult {
  const run = opts.run ?? realRunner;
  const home = resolveHome(opts.home);
  if (!path.isAbsolute(home)) throw new HomeError(`FLEET_HOME must be absolute, got ${JSON.stringify(home)}`);
  const createdHome = !fs.existsSync(home);
  fs.mkdirSync(home, { recursive: true });
  const root = fs.realpathSync(home);

  for (const { dir, mode } of HOME_DIRS) {
    const full = resolveInside(root, dir);
    fs.mkdirSync(full, { recursive: true, ...(mode ? { mode } : {}) });
    if (mode) fs.chmodSync(full, mode);
  }

  // .gitignore: keep whatever the owner wrote, append only the missing required lines.
  const giPath = path.join(root, '.gitignore');
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = REQUIRED_GITIGNORE.filter((l) => !have.has(l));
  let gitignoreChanged = false;
  if (missing.length > 0) {
    const head = existing === '' ? '# tula-fleet: never commit private material or service-owned state\n' : existing.endsWith('\n') ? existing : existing + '\n';
    fs.writeFileSync(giPath, head + missing.join('\n') + '\n');
    gitignoreChanged = true;
  }

  let gitInitialized = false;
  if (!fs.existsSync(path.join(root, '.git'))) {
    const r = run('git', ['init', '-q', '-b', 'main', root]);
    if (r.code !== 0) {
      throw new HomeError(r.missing ? 'git is not installed: $FLEET_HOME must be a git repo (A8)' : `git init failed: ${r.stderr.trim()}`);
    }
    gitInitialized = true;
  }
  return { home: root, createdHome, gitInitialized, gitignoreChanged };
}
