import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dir, '..');

/** Creates a temp dir and points CLAUDE_PROJECT_DIR at it. Call the returned restore() in afterEach. */
export function useTempProject(): { dir: string; restore: () => void } {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tula-fleet-test-'));
  process.env.CLAUDE_PROJECT_DIR = dir;
  return {
    dir,
    restore: () => {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Points CLAUDE_PROJECT_DIR at the real repo (read-only use: config, skills). */
export function useRepoProject(): () => void {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = repoRoot;
  return () => {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  };
}
