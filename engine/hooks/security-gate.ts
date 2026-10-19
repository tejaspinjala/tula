#!/usr/bin/env bun
// PreToolUse gate. Hard-denies dangerous/secret-touching actions; routes external actions to human approval.
import { readStdin } from '../lib/core.ts';
import type { HookEvent } from '../lib/core.ts';
import { actionId, isApproved, request } from '../lib/approvals.ts';

const DENY_CMD: [RegExp, string][] = [
  [/\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME)(\s|$)/, 'recursive delete of root/home'],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'piping a download into a shell'],
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, 'force push'],
  [/\bsudo\b/, 'sudo'],
  [/\bchmod\s+-R\s+777\b/, 'chmod -R 777'],
  [/:\(\)\s*\{/, 'fork bomb'],
];
const SECRET_PATH = /(^|\/)\.env(\.|$)|id_(rsa|ed25519)|\.pem$|\.aws\/credentials|(^|\/)\.ssh\//;
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

export interface GateDeps {
  approved?: (id: string) => boolean;
  ask?: typeof request;
}

export function decide(ev: HookEvent, { approved = isApproved, ask = request }: GateDeps = {}): Decision {
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

  const external = (tool === 'Bash' && EXTERNAL_CMD.test(cmd)) || EXTERNAL_MCP.test(tool);
  if (external) {
    const id = actionId(tool, input);
    if (approved(id)) return { decision: 'allow' };
    ask({ id, tool, input, by: ev.agent_type || 'tej' });
    return deny(`Needs human approval (id ${id}). Do not retry or work around it: stage the work, report to your parent that approval ${id} is pending, and continue with other tasks.`);
  }
  return { decision: 'allow' };
}

const deny = (reason: string): Decision => ({ decision: 'deny', reason });

if (import.meta.main) {
  const r = decide(readStdin());
  if (r.decision === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason },
    }));
  }
}
