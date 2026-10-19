import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalOptions } from '../../../engine/lib/approvals.ts';

export const H = 3600_000;
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

/** Separate temp FLEET_HOME and temp project (CLAUDE_PROJECT_DIR), plus a manual clock. */
export function setup(): {
  home: string;
  project: string;
  dir: string;
  clock: { t: number; advance: (ms: number) => void };
  opts: (extra?: Partial<ApprovalOptions>) => ApprovalOptions;
  cleanup: () => void;
} {
  const prevHome = process.env.FLEET_HOME;
  const prevProj = process.env.CLAUDE_PROJECT_DIR;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tula-fleet-apr-home-')));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tula-fleet-apr-proj-')));
  process.env.FLEET_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = project;
  const clock = { t: Date.parse('2026-10-19T12:00:00.000Z'), advance: (ms: number) => { clock.t += ms; } };
  const dir = path.join(home, 'approvals');
  return {
    home,
    project,
    dir,
    clock,
    opts: (extra = {}) => ({ dir, now: () => new Date(clock.t), ...extra }),
    cleanup: () => {
      if (prevHome === undefined) delete process.env.FLEET_HOME;
      else process.env.FLEET_HOME = prevHome;
      if (prevProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProj;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}
