#!/usr/bin/env bun
// PreToolUse gate. Hard-denies dangerous/secret-touching actions and any agent write to approval state;
// routes external actions to human approval (two-phase: reserve here, consume/release in post-approval.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdin, root, p, clip } from '../lib/core.ts';
import type { HookEvent } from '../lib/core.ts';
import { actionHash, approvalsDir, reserve, request } from '../lib/approvals.ts';

const DENY_CMD: [RegExp, string][] = [
  [/\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME)(\s|$)/, 'recursive delete of root/home'],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'piping a download into a shell'],
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, 'force push'],
  [/\bsudo\b/, 'sudo'],
  [/\bchmod\s+-R\s+777\b/, 'chmod -R 777'],
  [/:\(\)\s*\{/, 'fork bomb'],
];
const SECRET_PATH = /(^|[\s\/\"'=<>])\.env(\.|$|[\s\"';&|)])|id_(rsa|ed25519)|\.pem($|[\s\"';&|)])|\.aws\/credentials|(^|[\s\/\"'=])\.ssh($|[\s\/\"';&|)])/;
const SECRET_CONTENT: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];
const EXTERNAL_CMD =
  /\b(git\s+push|gh\s+(pr\s+merge|release|repo\s+create)|npm\s+publish|vercel\b[^\n]*--prod|aws\s+\S+\s+(delete|terminate|put|create)\S*|stripe\b|terraform\s+apply|kubectl\s+(apply|delete)|docker\s+push)\b|engine\/jobs\/publish/;
const EXTERNAL_MCP = /^mcp__.*(send|post|publish|tweet|upload|schedule|pay|charge|delete|share|create_event|reply|forward)/i;

export type Decision = { decision: 'allow' } | { decision: 'deny'; reason: string };

export interface ApprovalAsk {
  actionHash: string;
  tool: string;
  input: Record<string, unknown>;
  by: string;
}

export interface GateDeps {
  /** Reserve an approval for this action hash; truthy = reserved, the action may run. */
  approved?: (actionHash: string, ctx: { toolUseId?: string }) => unknown;
  /** Record a pending approval request; may return the approval (its id goes in the deny message). */
  ask?: (req: ApprovalAsk) => unknown;
}

const defaultApproved = (hash: string, ctx: { toolUseId?: string }) => reserve(hash, ctx);
const defaultAsk = (r: ApprovalAsk) =>
  request({ actionHash: r.actionHash, summary: clip(`${r.tool} ${JSON.stringify(r.input)}`, 400), requestedBy: r.by, kind: 'external' });

// ---- approval state is owned by the owner CLI; agents get no write path to it ----
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const APPROVAL_BASH: RegExp[] = [
  /\bengine\/+approvals\b/,
  /approvals\.(jsonl|head\.json|mutex)/,
  /\blib\/approvals(\.ts)?\b/,
  /\bapprove\.ts\b[^\n]*\b(approve|deny)\b/,
  /\bbun\s+(run\s+)?approve\s+(approve|deny)\b/,
];

/** Realpath of the deepest existing ancestor + the rest, so symlinks into the approvals dir are caught. */
function realish(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function protectedDirs(): string[] {
  const out = [p('engine', 'approvals'), path.join(os.homedir(), '.tula-fleet', 'approvals')];
  try {
    out.push(approvalsDir());
  } catch {
    // e.g. inside_project or a bad FLEET_HOME: still protect where it would have been
    const home = process.env.FLEET_HOME;
    if (home) out.push(path.resolve(root(), home, 'approvals'));
  }
  return [...new Set(out.flatMap((d) => [path.resolve(d), realish(path.resolve(d))]))];
}

const under = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

export function touchesApprovals(tool: string, input: Record<string, unknown>): boolean {
  const dirs = protectedDirs();
  if (WRITE_TOOLS.includes(tool)) {
    const target = String(input.file_path || input.notebook_path || input.path || '');
    if (!target) return false;
    const abs = path.resolve(root(), target);
    return dirs.some((d) => under(abs, d) || under(realish(abs), d));
  }
  if (tool === 'Bash') {
    const cmd = String(input.command || '');
    if (APPROVAL_BASH.some((re) => re.test(cmd))) return true;
    if (dirs.some((d) => cmd.includes(d))) return true;
    if (/(\.tula-fleet|FLEET_HOME)/.test(cmd) && /approvals/.test(cmd)) return true;
  }
  return false;
}

/** Actions that leave the machine and so need an approval. */
export function isExternal(tool: string, input: Record<string, unknown>): boolean {
  return (tool === 'Bash' && EXTERNAL_CMD.test(String(input.command || ''))) || EXTERNAL_MCP.test(tool);
}

export async function decide(ev: HookEvent, { approved = defaultApproved, ask = defaultAsk }: GateDeps = {}): Promise<Decision> {
  const tool = ev.tool_name || '';
  const input = ev.tool_input || {};
  const cmd = String(input.command || '');
  const target = String(input.file_path || input.path || '');

  if (tool === 'Bash') {
    for (const [re, why] of DENY_CMD) if (re.test(cmd)) return deny(`Blocked: ${why}.`);
    if (SECRET_PATH.test(cmd)) return deny('Blocked: command touches a secrets file.');
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && SECRET_PATH.test(target)) {
    return deny('Blocked: secrets file. Ask the human to provide the value via environment, not a file the agent can read.');
  }
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) {
    const body = String(input.content ?? input.new_string ?? JSON.stringify(input.edits ?? ''));
    if (SECRET_CONTENT.some((re) => re.test(body))) return deny('Blocked: content looks like a credential. Use an env var reference instead.');
  }

  if (touchesApprovals(tool, input)) {
    return deny('Blocked: approval state is owner-only. Agents cannot write approvals or run approve/deny; ask the owner.');
  }

  if (isExternal(tool, input)) {
    const hash = actionHash(tool, input);
    try {
      if (await approved(hash, ev.tool_use_id ? { toolUseId: ev.tool_use_id } : {})) return { decision: 'allow' };
      const rec = await ask({ actionHash: hash, tool, input, by: ev.agent_type || 'tej' });
      const id = rec && typeof rec === 'object' && 'id' in rec ? String((rec as { id: unknown }).id) : hash.slice(0, 12);
      return deny(`Needs human approval (id ${id}). Do not retry or work around it: stage the work, report to your parent that approval ${id} is pending, and continue with other tasks.`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return deny(`Blocked: approvals are unavailable (${clip(why, 200)}). Nothing external can run until the owner fixes this.`);
    }
  }
  return { decision: 'allow' };
}

const deny = (reason: string): Decision => ({ decision: 'deny', reason });

if (import.meta.main) {
  const r = await decide(readStdin());
  if (r.decision === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason },
    }));
  }
}
