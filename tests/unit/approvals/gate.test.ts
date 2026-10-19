import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../../../engine/hooks/security-gate.ts';
import { settle, outcomeOf } from '../../../engine/hooks/post-approval.ts';
import { runCli } from '../../../engine/bin/approve.ts';
import { list, get, approve } from '../../../engine/lib/approvals.ts';
import { setup } from './helpers.ts';

let s: ReturnType<typeof setup>;
beforeEach(() => { s = setup(); });
afterEach(() => s.cleanup());

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, agent_type: 'e-coder' });
const denied = async (ev: Parameters<typeof decide>[0]) => {
  const r = await decide(ev);
  return r.decision === 'deny' && /approval state is owner-only/.test(r.reason);
};

describe('gate denies agent writes to approval state', () => {
  test('Write / Edit / MultiEdit / NotebookEdit into $FLEET_HOME/approvals', async () => {
    const f = path.join(s.dir, 'approvals.jsonl');
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: f, content: '{}' } })).toBe(true);
    expect(await denied({ tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: 'b' } })).toBe(true);
    expect(await denied({ tool_name: 'MultiEdit', tool_input: { file_path: path.join(s.dir, 'approvals.head.json'), edits: [] } })).toBe(true);
    expect(await denied({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(s.dir, 'x.ipynb'), new_source: '' } })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: s.dir } })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: path.join(s.dir, 'sub', '..', 'approvals.jsonl'), content: '' } })).toBe(true);
  });
  test('Write / Edit into the old engine/approvals/ tree (relative and absolute)', async () => {
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: 'engine/approvals/approved/abc.json', content: '{}' } })).toBe(true);
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: path.join(s.project, 'engine/approvals/pending/x.json'), content: '{}' } })).toBe(true);
    expect(await denied({ tool_name: 'Edit', tool_input: { file_path: './engine/approvals/approved/abc.json', old_string: 'a', new_string: 'b' } })).toBe(true);
  });
  test('a symlink in the project pointing at the approvals dir does not help', async () => {
    fs.mkdirSync(s.dir, { recursive: true });
    fs.symlinkSync(s.dir, path.join(s.project, 'innocent'));
    expect(await denied({ tool_name: 'Write', tool_input: { file_path: 'innocent/approvals.jsonl', content: '{}' } })).toBe(true);
  });
  test('Bash redirects, tee, cd tricks, the approve CLI verbs and importing the module', async () => {
    const cmds = [
      `echo '{}' > ${path.join(s.dir, 'approvals.jsonl')}`,
      `echo '{}' >> $FLEET_HOME/approvals/approvals.jsonl`,
      `echo '{}' >> \${FLEET_HOME}/approvals/approvals.jsonl`,
      `printf x >> ~/.tula-fleet/approvals/approvals.jsonl`,
      `cd ~/.tula-fleet && echo x > approvals/approvals.jsonl`,
      `echo '{}' | tee engine/approvals/approved/abc.json`,
      `mkdir -p engine/approvals/approved && touch engine/approvals/approved/abc.json`,
      `cp /tmp/x approvals.jsonl`,
      `bun engine/bin/approve.ts approve apr_01ABC`,
      `bun run approve approve apr_01ABC`,
      `bun run approve deny apr_01ABC`,
      `bun -e "const a = await import('./engine/lib/approvals.ts'); await a.approve('x','owner')"`,
    ];
    for (const c of cmds) expect(await denied(bash(c)), c).toBe(true);
  });
  test('ordinary commands and reading the list are still allowed', async () => {
    for (const c of ['ls -la', 'bun test', 'bun run approve list', 'bun engine/bin/approve.ts list', 'echo approvals are pending']) {
      expect(await decide(bash(c)), c).toEqual({ decision: 'allow' });
    }
    expect(await decide({ tool_name: 'Write', tool_input: { file_path: path.join(s.home, 'notes.txt'), content: 'x' } })).toEqual({ decision: 'allow' });
    expect(await decide({ tool_name: 'Read', tool_input: { file_path: path.join(s.dir, 'approvals.jsonl') } })).toEqual({ decision: 'allow' });
  });
});

describe('two-phase use through the hooks', () => {
  const ev = { tool_name: 'Bash', tool_input: { command: 'npm publish' }, agent_type: 'e-scribe' };
  const owner = { isTTY: true, env: {}, out: () => {}, err: () => {} };

  async function approveViaCli() {
    expect((await decide(ev)).decision).toBe('deny');
    const [{ approval }] = await list();
    expect(await runCli(['approve', approval!.id], owner)).toBe(0);
    return approval!.id;
  }

  test('failure (PostToolUseFailure) releases; retry allowed; success consumes', async () => {
    const id = await approveViaCli();
    expect(await decide({ ...ev, tool_use_id: 'u1' })).toEqual({ decision: 'allow' });
    expect(await settle({ ...ev, hook_event_name: 'PostToolUseFailure', tool_use_id: 'u1', error: 'E401' })).toEqual({ action: 'released', approvalId: id });
    expect((await get(id))?.approval.status).toBe('released');
    expect(await decide({ ...ev, tool_use_id: 'u2' })).toEqual({ decision: 'allow' });
    expect(await settle({ ...ev, hook_event_name: 'PostToolUse', tool_use_id: 'u2', tool_response: { stdout: '+ pkg@1.0.0', stderr: '' } })).toEqual({ action: 'consumed', approvalId: id });
    expect((await get(id))?.approval).toMatchObject({ status: 'consumed', usesLeft: 0, decidedBy: 'owner' });
    expect((await decide({ ...ev, tool_use_id: 'u3' })).decision).toBe('deny');
  });

  test('a PostToolUse whose response reports an error or non-zero exit releases', async () => {
    const id = await approveViaCli();
    await decide({ ...ev, tool_use_id: 'u1' });
    expect(await settle({ ...ev, hook_event_name: 'PostToolUse', tool_use_id: 'u1', tool_response: { stdout: '', exitCode: 1 } })).toMatchObject({ action: 'released' });
    await decide(ev); // no tool_use_id: settles by action hash
    expect(await settle({ ...ev, hook_event_name: 'PostToolUse', tool_response: { interrupted: true } })).toMatchObject({ action: 'released' });
    expect((await get(id))?.approval.status).toBe('released');
  });

  test('settle ignores non-external tools and other calls', async () => {
    await approveViaCli();
    await decide({ ...ev, tool_use_id: 'u1' });
    expect(await settle({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ action: 'none' });
    // same command, different tool_use_id: not this call's reservation
    expect(await settle({ ...ev, hook_event_name: 'PostToolUse', tool_use_id: 'other' })).toEqual({ action: 'none' });
    // different input: different hash
    expect(await settle({ ...ev, tool_input: { command: 'npm publish --tag x' }, hook_event_name: 'PostToolUse', tool_use_id: 'u1' })).toEqual({ action: 'none' });
  });

  test('outcomeOf', () => {
    expect(outcomeOf({ hook_event_name: 'PostToolUseFailure' })).toBe('failure');
    expect(outcomeOf({ hook_event_name: 'PostToolUse', tool_response: { isError: true, content: [] } })).toBe('failure');
    expect(outcomeOf({ hook_event_name: 'PostToolUse', tool_response: { is_error: true } })).toBe('failure');
    expect(outcomeOf({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'x', exitCode: 0 } })).toBe('success');
    expect(outcomeOf({ hook_event_name: 'PostToolUse', tool_response: 'ok' })).toBe('success');
  });
});

describe('owner CLI', () => {
  test('approve/deny refuse without a TTY or inside a Claude Code shell; owner approval records decidedBy owner', async () => {
    await decide({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, agent_type: 'e-scribe' });
    const [{ approval }] = await list();
    const errs: string[] = [];
    const c = (isTTY: boolean, env: Record<string, string>) => ({ isTTY, env, out: () => {}, err: (x: string) => { errs.push(x); } });
    expect(await runCli(['approve', approval!.id], c(false, {}))).toBe(3);
    expect(await runCli(['approve', approval!.id], c(true, { CLAUDECODE: '1' }))).toBe(3);
    expect(await runCli(['deny', approval!.id], c(false, {}))).toBe(3);
    expect((await get(approval!.id))?.approval.status).toBe('pending');
    expect(await runCli(['approve', approval!.id], c(true, {}))).toBe(0);
    expect((await get(approval!.id))?.approval).toMatchObject({ status: 'approved', decidedBy: 'owner' });
    expect(await runCli(['approve', approval!.id], c(true, {}))).toBe(1); // not pending any more
    const out: string[] = [];
    expect(await runCli(['list'], { isTTY: false, env: {}, out: (x) => { out.push(x); }, err: () => {} })).toBe(0);
    expect(out.join('\n')).toContain(approval!.id);
    expect(await runCli(['verify'], { isTTY: false, env: {}, out: () => {}, err: () => {} })).toBe(0);
    expect(errs.length).toBeGreaterThan(0);
  });

  test('the real CLI process refuses approve when stdin is not a TTY', async () => {
    await decide({ tool_name: 'Bash', tool_input: { command: 'npm publish' }, agent_type: 'e-scribe' });
    const [{ approval }] = await list();
    const cli = path.join(import.meta.dir, '..', '..', '..', 'engine', 'bin', 'approve.ts');
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const p = Bun.spawn([process.execPath, cli, 'approve', approval!.id], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env });
    expect(await p.exited).toBe(3);
    expect((await get(approval!.id))?.approval.status).toBe('pending');
    // an agent-forged approve via the library with a non-owner identity is refused too
    await expect(approve(approval!.id, 'e-scribe')).rejects.toThrow(/self_approval/);
  });
});
