#!/usr/bin/env bun
// Owner approval CLI. The only caller of approvals.decide(); records decidedBy 'owner'.
//   bun engine/bin/approve.ts list | approve <id> | deny <id> [reason] | verify
// approve/deny refuse to run from an agent shell: they need an interactive terminal and no CLAUDECODE
// in the environment. The security gate also denies agent Bash calls that invoke approve/deny.
// These are speed bumps, not a security boundary (see engine/lib/README.md, approvals.ts limitations).
import { list, approve, deny, verifyLog, OWNER, ApprovalError } from '../lib/approvals.ts';

export interface CliEnv {
  isTTY: boolean;
  env: Record<string, string | undefined>;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function ownerShell(c: Pick<CliEnv, 'isTTY' | 'env'>): string | null {
  if (c.env.CLAUDECODE) return 'refusing: running inside a Claude Code agent shell (CLAUDECODE is set)';
  if (!c.isTTY) return 'refusing: approve/deny need an interactive terminal (stdin is not a TTY)';
  return null;
}

export async function runCli(argv: string[], c: CliEnv): Promise<number> {
  const [cmd, id, ...rest] = argv;
  try {
    if (cmd === 'list' || !cmd) {
      const items = (await list()).filter((s) => s.approval.status !== 'consumed');
      if (!items.length) c.out('no open approvals');
      for (const { approval: a } of items) {
        c.out(`${a.id}  ${a.status.padEnd(8)}  [${a.requestedBy}]  expires ${a.expiresAt}  ${a.summary}`);
      }
      return 0;
    }
    if (cmd === 'verify') {
      const r = await verifyLog();
      if (r.ok) c.out(`approvals log ok (${r.count} approvals)`);
      else c.err(r.error);
      return r.ok ? 0 : 1;
    }
    if ((cmd === 'approve' || cmd === 'deny') && id) {
      const why = ownerShell(c);
      if (why) {
        c.err(why);
        return 3;
      }
      if (cmd === 'approve') {
        await approve(id, OWNER);
        c.out(`approved ${id} (single use, until it expires)`);
      } else {
        await deny(id, OWNER, rest.join(' ') || undefined);
        c.out(`denied ${id}`);
      }
      return 0;
    }
    c.err('usage: approve.ts list | approve <id> | deny <id> [reason] | verify');
    return 2;
  } catch (e) {
    c.err(e instanceof ApprovalError ? e.message : `error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    isTTY: !!process.stdin.isTTY,
    env: process.env,
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  });
  process.exit(code);
}
