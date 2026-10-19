#!/usr/bin/env bun
// Turns hook payloads into the event stream the pixel office reads. Prints nothing (zero token cost).
// Conversation tracking: PreToolUse(Agent) = "from -> to" message with the real prompt;
// SubagentStart links the new agent_id to its caller; SubagentStop = the report back to that caller.
import type { HookEvent } from '../lib/core.ts';
import { readStdin, clip, appendEvent, readEventsTailText } from '../lib/core.ts';
import { type Links, emptyLinks, applyDelegate, applySpawn, deriveLinks, parseEvents } from '../lib/derive.ts';

export type { Links };

// The hook only APPENDS events (one O_APPEND line each). `links` is derived from the event tail in memory and
// is never written back; the authoritative derivation over the whole stream is deriveLinks() in lib/derive.ts.
export function toEvents(ev: HookEvent, links: Links = emptyLinks()): { events: Record<string, unknown>[]; links: Links } {
  const name = ev.hook_event_name;
  const who = ev.agent_type || 'tej';
  const out: Record<string, unknown>[] = [];
  switch (name) {
    case 'PreToolUse': {
      if ((ev.tool_name === 'Agent' || ev.tool_name === 'Task') && ev.tool_input?.subagent_type) {
        const to = String(ev.tool_input.subagent_type);
        applyDelegate(links, { from: who, to, ...(ev.agent_id ? { from_id: ev.agent_id } : {}), ...(ev.session_id ? { session: ev.session_id } : {}) });
        out.push({ event: 'msg', kind: 'delegate', from: who, ...(ev.agent_id ? { from_id: ev.agent_id } : {}), to, text: clip(ev.tool_input.prompt || ev.tool_input.description, 400) });
      } else {
        out.push({ event: 'tool', agent: who, tool: ev.tool_name, text: clip(JSON.stringify(ev.tool_input), 160) });
      }
      break;
    }
    case 'SubagentStart': {
      const parent = applySpawn(links, { agent_type: ev.agent_type, agent_id: ev.agent_id, parent_agent_id: ev.parent_agent_id, session: ev.session_id });
      out.push({ event: 'spawn', agent: ev.agent_type, parent, agent_id: ev.agent_id, ...(ev.parent_agent_id ? { parent_agent_id: ev.parent_agent_id } : {}) });
      break;
    }
    case 'SubagentStop': {
      const to = (ev.agent_id && links.parents[ev.agent_id]) || 'tej';
      if (ev.agent_id) delete links.parents[ev.agent_id];
      out.push({ event: 'msg', kind: 'report', from: ev.agent_type, ...(ev.agent_id ? { agent_id: ev.agent_id } : {}), to, text: clip(ev.last_assistant_message, 400) });
      out.push({ event: 'done', agent: ev.agent_type, ...(ev.agent_id ? { agent_id: ev.agent_id } : {}) });
      break;
    }
    case 'UserPromptSubmit':
      out.push({ event: 'msg', kind: 'human', from: 'human', to: 'tej', text: clip(ev.prompt, 400) });
      break;
    case 'Stop':
      out.push({ event: 'msg', kind: 'report', from: 'tej', to: 'human', text: clip(ev.last_assistant_message, 400) });
      break;
    case 'PreCompact':
      out.push({ event: 'compact', agent: who, text: ev.trigger || '' });
      break;
    case 'SessionStart':
    case 'SessionEnd':
      out.push({ event: name === 'SessionStart' ? 'session' : 'session_end', text: ev.source || ev.reason || '' });
      break;
    default:
      break;
  }
  return { events: out, links };
}

export async function main(): Promise<void> {
  try {
    const ev = readStdin();
    // Read-only view of recent history; nothing is persisted from it.
    const links = deriveLinks(parseEvents(readEventsTailText()));
    for (const e of toEvents(ev, links).events) appendEvent({ session: ev.session_id, ...e });
  } catch { /* logging must never break the agent */ }
}

if (import.meta.main) await main();
