import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as cli } from '../../../engine/cli/template.ts';
import { BUILTIN_TEMPLATES_DIR } from '../../../engine/template/load.ts';

export const STARTER = ['org-full-life', 'defaults-v1', 'roles-content', 'roles-verification'];

const cleanups: string[] = [];
export function tmp(label = 'fleet-tpl'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  cleanups.push(d);
  return d;
}
export const cleanupTmp = () => cleanups.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

export function freshHomePath(): string {
  return path.join(tmp(), 'fleet');
}

export async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await cli(args, { out: (s) => (out += s + '\n'), err: (s) => (err += s + '\n') });
  return { code, out, err };
}

export async function importStarter(home: string, extra: string[] = []) {
  return run(['import', ...STARTER, '--home', home, '--apply', ...extra]);
}

export function git(home: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: home, stdout: 'pipe', stderr: 'pipe' });
  return r.stdout.toString().trim();
}

export const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
export function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

/** Copies a shipped template into a new templates root so a test can edit it. */
export function copyTemplate(id: string, root: string): string {
  const dest = path.join(root, id);
  fs.cpSync(path.join(BUILTIN_TEMPLATES_DIR, id), dest, { recursive: true });
  return dest;
}

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') go(p); } else out.push(p);
    }
  };
  go(dir);
  return out;
}
