// Pure derivation of agent links and context usage from the append-only event stream (events.jsonl).
// Hooks only append events; they never read-modify-write shared files. Anything that used to live in
// links.json / ctx.json is recomputed here from the events, and a persisted snapshot (if wanted) is
// written through the locked store by `writeSnapshots`.
import { z } from 'zod';

export interface StoredEvent {
  ts?: string;
  session?: string;
  event?: string;
  [k: string]: unknown;
}

export interface PendingDelegate {
  from: string;
  to: string;
  from_id?: string;
  session?: string;
}

/** Spawn bookkeeping. `parents` maps child agent_id -> parent agent name ('tej' = the main session). */
export interface Links {
  pending: PendingDelegate[];
  parents: Record<string, string>;
  /** child agent_id -> parent agent_id, when known (explicit parent_agent_id or the delegating hook's agent_id). */
  parentIds?: Record<string, string>;
  /** agent_id -> agent_type, from SubagentStart. */
  names?: Record<string, string>;
}

export const emptyLinks = (): Links => ({ pending: [], parents: {}, parentIds: {}, names: {} });

export function applyDelegate(links: Links, d: PendingDelegate): void {
  links.pending.push(d);
}

/**
 * Resolves the parent of a new subagent and records it.
 * 1. explicit parent_agent_id (exact), 2. else the oldest pending delegate to the same agent_type in the
 * same session (FIFO; ambiguous only when several same-type spawns are in flight and no parent_agent_id is given).
 */
export function applySpawn(links: Links, s: { agent_type?: string; agent_id?: string; parent_agent_id?: string; session?: string }): string {
  links.names ??= {};
  links.parentIds ??= {};
  let parent: string | undefined;
  let parentId = s.parent_agent_id || undefined;
  if (parentId) {
    const i = links.pending.findIndex((x) => x.from_id === parentId && x.to === s.agent_type);
    if (i >= 0) parent = (links.pending.splice(i, 1)[0] as PendingDelegate).from;
    else parent = links.names[parentId];
  } else {
    const i = links.pending.findIndex((x) => x.to === s.agent_type && (!s.session || !x.session || x.session === s.session));
    if (i >= 0) {
      const d = links.pending.splice(i, 1)[0] as PendingDelegate;
      parent = d.from;
      parentId = d.from_id;
    }
  }
  parent ||= 'tej';
  if (s.agent_id) {
    links.parents[s.agent_id] = parent;
    if (s.agent_type) links.names[s.agent_id] = s.agent_type;
    if (parentId) links.parentIds[s.agent_id] = parentId;
  }
  return parent;
}

/** Replays the event stream. Child -> parent by agent_id. Finished agents keep their link. */
export function deriveLinks(events: readonly StoredEvent[]): Links {
  const links = emptyLinks();
  for (const e of events) {
    if (e.event === 'msg' && e.kind === 'delegate' && typeof e.from === 'string' && typeof e.to === 'string') {
      applyDelegate(links, {
        from: e.from,
        to: e.to,
        ...(typeof e.from_id === 'string' ? { from_id: e.from_id } : {}),
        ...(typeof e.session === 'string' ? { session: e.session } : {}),
      });
    } else if (e.event === 'spawn' && typeof e.agent === 'string') {
      applySpawn(links, {
        agent_type: e.agent,
        agent_id: typeof e.agent_id === 'string' ? e.agent_id : undefined,
        parent_agent_id: typeof e.parent_agent_id === 'string' ? e.parent_agent_id : undefined,
        session: typeof e.session === 'string' ? e.session : undefined,
      });
    }
  }
  return links;
}

export interface CtxEntry {
  level: number;
  pct: number;
  tokens?: number;
  agent?: string;
  agent_id?: string;
  session?: string;
  ts?: string;
}

export const ctxKey = (session: string | undefined, agentId: string | undefined): string => `${session ?? ''}:${agentId || 'main'}`;

/** Latest context usage per session/agent, from `ctx` events (later events win). */
export function deriveCtx(events: readonly StoredEvent[], hard = 35, warn = 30): Record<string, CtxEntry> {
  const out: Record<string, CtxEntry> = {};
  for (const e of events) {
    if (e.event !== 'ctx' || typeof e.pct !== 'number' || !Number.isFinite(e.pct)) continue;
    const session = typeof e.session === 'string' ? e.session : undefined;
    const agent_id = typeof e.agent_id === 'string' ? e.agent_id : undefined;
    out[ctxKey(session, agent_id)] = {
      level: typeof e.level === 'number' ? e.level : e.pct >= hard ? 2 : e.pct >= warn ? 1 : 0,
      pct: e.pct,
      ...(typeof e.tokens === 'number' ? { tokens: e.tokens } : {}),
      ...(typeof e.agent === 'string' ? { agent: e.agent } : {}),
      ...(agent_id ? { agent_id } : {}),
      ...(session ? { session } : {}),
      ...(typeof e.ts === 'string' ? { ts: e.ts } : {}),
    };
  }
  return out;
}

/** Parses JSONL text. Blank, malformed and non-object lines are skipped (e.g. the cut first line of a tail window). */
export function parseEvents(text: string): StoredEvent[] {
  const out: StoredEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as StoredEvent);
    } catch { /* torn or foreign line */ }
  }
  return out;
}

export const LinksSnapshotSchema = z.object({
  pending: z.array(z.object({ from: z.string(), to: z.string(), from_id: z.string().optional(), session: z.string().optional() })),
  parents: z.record(z.string(), z.string()),
  parentIds: z.record(z.string(), z.string()).optional(),
  names: z.record(z.string(), z.string()).optional(),
});

export const CtxSnapshotSchema = z.record(z.string(), z.object({
  level: z.number(), pct: z.number(), tokens: z.number().optional(), agent: z.string().optional(),
  agent_id: z.string().optional(), session: z.string().optional(), ts: z.string().optional(),
}));
