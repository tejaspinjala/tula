#!/usr/bin/env bun
// Before any compaction: drop a handoff stub in the brain so nothing important is lost,
// and so the post-compact SessionStart hook can point the agent straight back to it.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { HookEvent } from '../lib/core.ts';
import { readStdin, p, ensureDir } from '../lib/core.ts';

export function handoffPath(ev: HookEvent, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const who = (ev.agent_type || 'tej').replace(/[^a-z0-9-]/gi, '');
  return p('brain', 'runs', `${stamp}-${who}-compact.md`);
}

export function handoffBody(ev: HookEvent, git = ''): string {
  return `---
type: handoff
status: auto
agent: ${ev.agent_type || 'tej'}
trigger: ${ev.trigger || 'auto'}
session: ${ev.session_id || ''}
---
# Auto handoff (pre-compact)
Written by the PreCompact hook. The agent should fill **Done / Next / Open** after compaction (skill: handoff).

## Working tree
\`\`\`
${git.trim() || '(clean or not a git repo)'}
\`\`\`

## Done
- (fill in)

## Next
- (fill in)

## Open questions / unverified
- (fill in)
`;
}

if (import.meta.main) {
  const ev = readStdin();
  let git = '';
  try { git = execSync('git status --short | head -30', { cwd: p('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not a repo */ }
  const f = handoffPath(ev);
  ensureDir(p('brain', 'runs'));
  fs.writeFileSync(f, handoffBody(ev, git));
}
