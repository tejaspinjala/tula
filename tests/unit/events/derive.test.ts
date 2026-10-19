import { test, expect, describe } from 'bun:test';
import { deriveLinks, deriveCtx, ctxKey, parseEvents, type StoredEvent } from '../../../engine/lib/derive.ts';

const delegate = (from: string, to: string, from_id?: string, session = 's1'): StoredEvent =>
  ({ event: 'msg', kind: 'delegate', from, to, ...(from_id ? { from_id } : {}), session });
const spawn = (agent: string, agent_id: string, parent_agent_id?: string, session = 's1'): StoredEvent =>
  ({ event: 'spawn', agent, agent_id, ...(parent_agent_id ? { parent_agent_id } : {}), session });

describe('deriveLinks', () => {
  test('two parallel same-type subagents link to their own (different) parents by agent_id', () => {
    const events = [
      spawn('mgr-a', 'p1'), spawn('mgr-b', 'p2'),
      delegate('mgr-a', 'e-coder', 'p1'), delegate('mgr-b', 'e-coder', 'p2'),
      // children start in the opposite order of the delegations
      spawn('e-coder', 'c2', 'p2'), spawn('e-coder', 'c1', 'p1'),
    ];
    const l = deriveLinks(events);
    expect(l.parents.c1).toBe('mgr-a');
    expect(l.parents.c2).toBe('mgr-b');
    expect(l.parentIds).toMatchObject({ c1: 'p1', c2: 'p2' });
    expect(l.pending).toEqual([]);
  });
  test('parent_agent_id wins even with no delegate event', () => {
    const l = deriveLinks([spawn('mgr-a', 'p1'), spawn('e-coder', 'c1', 'p1')]);
    expect(l.parents.c1).toBe('mgr-a');
  });
  test('without parent_agent_id it falls back to FIFO by type within the session', () => {
    const l = deriveLinks([delegate('mgr-a', 'e-coder', 'p1'), delegate('mgr-b', 'e-coder', 'p2'), spawn('e-coder', 'c1'), spawn('e-coder', 'c2')]);
    expect(l.parents).toEqual({ c1: 'mgr-a', c2: 'mgr-b' });
    expect(l.parentIds).toEqual({ c1: 'p1', c2: 'p2' });
  });
  test('other sessions do not steal a delegate; unlinked spawn defaults to tej', () => {
    const l = deriveLinks([delegate('mgr-a', 'e-coder', 'p1', 'other'), spawn('e-coder', 'c1')]);
    expect(l.parents.c1).toBe('tej');
    expect(l.pending).toHaveLength(1);
  });
  test('links survive the agent finishing; ignores junk events', () => {
    const l = deriveLinks([delegate('tej', 'x'), spawn('x', 'a1'), { event: 'done', agent: 'x', agent_id: 'a1' }, { event: 'tool' }, { event: 'spawn' }]);
    expect(l.parents).toEqual({ a1: 'tej' });
  });
});

describe('deriveCtx', () => {
  test('latest usage per session/agent wins; levels from pct or stored level', () => {
    const ev: StoredEvent[] = [
      { event: 'ctx', session: 's1', pct: 10, tokens: 20000 },
      { event: 'ctx', session: 's1', agent_id: 'a1', pct: 31, agent: 'e-coder' },
      { event: 'ctx', session: 's1', pct: 36.5, tokens: 73000 },
      { event: 'ctx', session: 's2', pct: 5 },
      { event: 'ctx', session: 's1', agent_id: 'a1', pct: 20 },
      { event: 'ctx', session: 's3', pct: 29.96, level: 1 },
      { event: 'ctx', session: 's1', pct: 'bad' },
      { event: 'tool' },
    ];
    const c = deriveCtx(ev);
    expect(c[ctxKey('s1', undefined)]).toMatchObject({ pct: 36.5, level: 2, tokens: 73000 });
    expect(c[ctxKey('s1', 'a1')]).toMatchObject({ pct: 20, level: 0, agent_id: 'a1' });
    expect(c[ctxKey('s2', undefined)]).toMatchObject({ pct: 5, level: 0 });
    expect(c[ctxKey('s3', undefined)]).toMatchObject({ level: 1 });
    expect(Object.keys(c)).toHaveLength(4);
  });
  test('thresholds match the guard (30 warn, 35 hard)', () => {
    const c = deriveCtx([{ event: 'ctx', session: 'a', pct: 30 }, { event: 'ctx', session: 'b', pct: 35 }, { event: 'ctx', session: 'c', pct: 29.9 }]);
    expect([c[ctxKey('a', undefined)]!.level, c[ctxKey('b', undefined)]!.level, c[ctxKey('c', undefined)]!.level]).toEqual([1, 2, 0]);
  });
});

test('parseEvents skips torn, blank and non-object lines', () => {
  expect(parseEvents('{"a":1}\n\nnot json\n[1]\n{"b":2')).toEqual([{ a: 1 }]);
});
