// Injectable command runner. Everything in engine/home that shells out takes one, so tests can fake
// `fdesetup`, `lsblk`, `age` and `git` without touching the machine.
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the executable does not exist on PATH. */
  missing?: boolean;
}
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => RunResult;

export const realRunner: Runner = (cmd, args, opts) => {
  try {
    const r = Bun.spawnSync([cmd, ...args], { cwd: opts?.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT' || /not found|ENOENT/i.test(String(e))) return { code: 127, stdout: '', stderr: String(e), missing: true };
    return { code: 1, stdout: '', stderr: String(e) };
  }
};
