#!/usr/bin/env bun
// Keeps every agent under 35% of its context window.
// Hard enforcement is CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=35 (settings.json env). This hook is the polite layer:
// at 30% it tells the agent to finish its unit and hand off; at 35% it tells it to stop and hand off.
// Reads real usage from the transcript (input + cache read + cache creation tokens of the last assistant turn).
import fs from 'node:fs';
import { readStdin, readJSONState, writeJSONState, appendEvent, sha } from '../lib/core.ts';

export const WARN = 30;
export const HARD = 35;

export function contextTokens(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const o = JSON.parse(lines[i]);
        const u = o?.message?.usage;
        if (u && (o.type === 'assistant' || o.message.role === 'assistant')) {
          return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
      } catch { /* partial first line of the tail window */ }
    }
  } catch { /* unreadable transcript: stay silent */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

export function evaluate({ tokens, window, prev = { level: 0, pct: 0 } }) {
  const pct = (tokens / window) * 100;
  const level = pct >= HARD ? 2 : pct >= WARN ? 1 : 0;
  const emit = level > prev.level || (level === 2 && pct >= prev.pct + 5);
  const r = Math.round(pct);
  const msg = !emit ? null
    : level === 2
      ? `[ctx ${r}%] LIMIT (35%). Stop starting new work. Write a handoff now (bun fleet/bin/skill.ts handoff) and return a <=150-word summary to your parent.`
      : `[ctx ${r}%] Nearing the 35% limit. Finish the current unit, then write a handoff (bun fleet/bin/skill.ts handoff) instead of starting anything new.`;
  return { pct, level, emit, msg, next: { level, pct } };
}

if (import.meta.main) {
  const ev = readStdin();
  const file = ev.agent_transcript_path || ev.transcript_path;
  const tokens = file ? contextTokens(file) : null;
  if (tokens == null) process.exit(0);
  const window = Number(process.env.FLEET_CONTEXT_WINDOW) || 200_000;
  const key = sha(`${ev.session_id}:${ev.agent_id || 'main'}`);
  const state = readJSONState('ctx.json', {});
  const r = evaluate({ tokens, window, prev: state[key] });
  if (Math.abs(r.pct - (state[key]?.pct ?? -99)) >= 1) {
    appendEvent({ event: 'ctx', agent: ev.agent_type || 'tej', pct: Math.round(r.pct * 10) / 10, tokens });
  }
  state[key] = r.next;
  writeJSONState('ctx.json', state);
  if (r.msg) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: ev.hook_event_name || 'PostToolUse', additionalContext: r.msg },
    }));
  }
}
