// The only git the importer does: stage the files it wrote and make ONE commit in $FLEET_HOME.
import { realRunner, type Runner } from '../home/run.ts';

export class GitError extends Error {}

function git(run: Runner, home: string, args: string[]): string {
  const r = run('git', args, { cwd: home });
  if (r.code !== 0) throw new GitError(r.missing ? 'git is not installed' : `git ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function isTracked(home: string, rel: string, run: Runner = realRunner): boolean {
  return run('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: home }).code === 0;
}

/** Commits exactly `files` (relative paths). Uses a neutral local identity when none is configured. Returns the commit sha. */
export function commitFiles(home: string, files: string[], message: string, run: Runner = realRunner): string {
  git(run, home, ['add', '--', ...files]);
  const identity: string[] = [];
  for (const [key, fallback] of [['user.name', 'fleet'], ['user.email', 'fleet@localhost']] as const) {
    const cur = run('git', ['config', key], { cwd: home });
    if (cur.code !== 0 || !cur.stdout.trim()) identity.push('-c', `${key}=${fallback}`);
  }
  try {
    git(run, home, [...identity, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message, '--', ...files]);
  } catch (e) {
    run('git', ['reset', '-q', '--', ...files], { cwd: home });
    throw e;
  }
  return git(run, home, ['rev-parse', 'HEAD']).trim();
}
