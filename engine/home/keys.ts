// age identity (SPEC 11). We never implement crypto: `age-keygen` does the work. If age is not installed
// this reports it plainly. The private key lives at $FLEET_HOME/private/age-identity.txt (mode 0600, dir 0700;
// private/ is git-ignored). The public recipient is written next to it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../lib/paths.ts';
import { realRunner, type Runner } from './run.ts';

export const IDENTITY_FILE = 'private/age-identity.txt';
export const RECIPIENT_FILE = 'private/age-recipient.txt';

export type KeysInitResult =
  | { status: 'created' | 'exists'; identityPath: string; recipient: string }
  | { status: 'not_installed'; message: string };

export function ageInstalled(run: Runner): boolean {
  const a = run('age', ['--version']);
  const k = run('age-keygen', ['--version']);
  return !a.missing && !k.missing && a.code === 0 && k.code === 0;
}

function recipientOf(identity: string): string | undefined {
  return /^# public key: (age1[a-z0-9]+)\s*$/m.exec(identity)?.[1];
}

export function keysInit(opts: { home: string; run?: Runner }): KeysInitResult {
  const run = opts.run ?? realRunner;
  const idPath = resolveInside(opts.home, IDENTITY_FILE);
  const recPath = resolveInside(opts.home, RECIPIENT_FILE);
  if (fs.existsSync(idPath)) {
    const rec = recipientOf(fs.readFileSync(idPath, 'utf8'));
    if (!rec) throw new Error(`${idPath} exists but has no '# public key:' line; refusing to overwrite it`);
    fs.chmodSync(idPath, 0o600);
    return { status: 'exists', identityPath: idPath, recipient: rec };
  }
  if (!ageInstalled(run)) {
    return { status: 'not_installed', message: 'age / age-keygen not installed: install age (https://age-encryption.org) and re-run `keys init`; private notes cannot be encrypted until then' };
  }
  fs.mkdirSync(path.dirname(idPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(idPath), 0o700);
  const r = run('age-keygen', ['-o', idPath]);
  if (r.code !== 0) throw new Error(`age-keygen failed: ${r.stderr.trim()}`);
  fs.chmodSync(idPath, 0o600);
  const rec = recipientOf(fs.readFileSync(idPath, 'utf8')) ?? /(age1[a-z0-9]+)/.exec(r.stderr + r.stdout)?.[1];
  if (!rec) throw new Error('age-keygen did not report a public key');
  fs.writeFileSync(recPath, rec + '\n', { mode: 0o644 });
  return { status: 'created', identityPath: idPath, recipient: rec };
}
