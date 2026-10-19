#!/usr/bin/env bun
// Turns hook payloads into the event stream the pixel office reads. Prints nothing (zero token cost).
// Conversation tracking: PreToolUse(Agent) = "from -> to" message with the real prompt;
// SubagentStart links the new agent_id to its caller; SubagentStop = the report back to that caller.
import { readStdin, clip, appendEvent, readJSONState, writeJSONState } from '../lib/core.ts';

export function toEvents(ev, links = { pending: [], parents: {} }) {
  const name = ev.hook_event_name;
  const who = ev.agent_type || 'tej';
  const out = [];
  switch (name) {
    case 'PreToolUse': {
      if ((ev.tool_name === 'Agent' || ev.tool_name === 'Task') && ev.tool_input?.subagent_type) {
        const to = ev.tool_input.subagent_type;
        links.pending.push({ from: who, to });
        out.push({ event: 'msg', kind: 'delegate', from: who, to, text: clip(ev.tool_input.prompt || ev.tool_input.description, 400) });
      } else {
        out.push({ event: 'tool', agent: who, tool: ev.tool_name, text: clip(JSON.stringify(ev.tool_input), 160) });
      }
      break;
    }
    case 'SubagentStart': {
      const i = links.pending.findIndex((x) => x.to === ev.agent_type);
      const parent = i >= 0 ? links.pending.splice(i, 1)[0].from : 'tej';
      if (ev.agent_id) links.parents[ev.agent_id] = parent;
      out.push({ event: 'spawn', agent: ev.agent_type, parent, agent_id: ev.agent_id });
      break;
    }
    case 'SubagentStop': {
      const to = links.parents[ev.agent_id] || 'tej';
      delete links.parents[ev.agent_id];
      out.push({ event: 'msg', kind: 'report', from: ev.agent_type, to, text: clip(ev.last_assistant_message, 400) });
      out.push({ event: 'done', agent: ev.agent_type });
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

if (import.meta.main) {
  const ev = readStdin();
  const links = readJSONState('links.json', { pending: [], parents: {} });
  const r = toEvents(ev, links);
  writeJSONState('links.json', r.links);
  for (const e of r.events) appendEvent({ session: ev.session_id, ...e });
}
