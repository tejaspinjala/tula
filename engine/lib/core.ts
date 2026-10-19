// Shared, zero-dependency helpers for hooks, scripts and the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Shape of the JSON a Claude Code hook receives on stdin. Only fields we read are listed. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  parent_agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  last_assistant_message?: string;
  source?: string;
  reason?: string;
  trigger?: string;
}

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

export const root = (): string => process.env.CLAUDE_PROJECT_DIR || process.cwd();
export const p = (...parts: string[]): string => path.join(root(), ...parts);
export const ensureDir = (d: string) => fs.mkdirSync(d, { recursive: true });
export const clip = (s: unknown, n = 200): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function readStdin(): HookEvent {
  try {
    const s = fs.readFileSync(0, 'utf8');
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function loadJSON<T = unknown>(rel: string): T {
  return JSON.parse(fs.readFileSync(p(rel), 'utf8'));
}

/** Max bytes of one events.jsonl line including the newline. Kept under PIPE_BUF so an O_APPEND write is not interleaved. */
export const MAX_EVENT_BYTES = 4096;

/**
 * Serialises one event to a single line of at most `max` bytes (newline included). If it is too big the longest
 * string fields are cut (with an ellipsis) and `truncated: true` is set; the event is never split over two lines.
 */
export function encodeEventLine(ev: Record<string, unknown>, max = MAX_EVENT_BYTES): string {
  const obj: Record<string, unknown> = { ...ev };
  const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o), 'utf8') + 1;
  if (size(obj) <= max) return JSON.stringify(obj) + '\n';
  obj.truncated = true;
  for (let guard = 0; guard < 200 && size(obj) > max; guard++) {
    let key: string | undefined;
    let len = 0;
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v.length > len) { key = k; len = v.length; }
    if (!key || len <= 64) break; // never shrink short routing fields to nothing
    const over = size(obj) - max;
    const cut = Math.max(1, Math.min(len - 64, over));
    obj[key] = (obj[key] as string).slice(0, len - cut - 1) + '…';
  }
  if (size(obj) > max) {
    // Non-string payload (or hopelessly large): keep only the routing fields.
    const keep: Record<string, unknown> = { truncated: true };
    for (const k of ['ts', 'session', 'event', 'kind', 'agent', 'agent_id']) if (typeof ev[k] === 'string') keep[k] = String(ev[k]).slice(0, 200);
    return JSON.stringify(keep) + '\n';
  }
  return JSON.stringify(obj) + '\n';
}

export const eventsFile = (): string => p('engine', 'state', 'events.jsonl');

/**
 * Appends one event line with a single O_APPEND write (no read, no lock, no shared state to corrupt).
 * Fails open: logging problems return false instead of throwing.
 */
export function appendEvent(ev: Record<string, unknown>): boolean {
  let fd: number | undefined;
  try {
    const f = eventsFile();
    ensureDir(path.dirname(f));
    const buf = Buffer.from(encodeEventLine({ ts: new Date().toISOString(), ...ev }), 'utf8');
    fd = fs.openSync(f, 'a');
    return fs.writeSync(fd, buf, 0, buf.length) === buf.length;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Reads the last `maxBytes` of events.jsonl as text, dropping the (possibly cut) first line of a partial window. Read-only. */
export function readEventsTailText(maxBytes = 512 * 1024, file = eventsFile()): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export const sha = (s: string, n = 12): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// Minimal frontmatter parser: `key: value`, `key: [a, b]`, and `key:` + `- item` lists.
export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (li && listKey) {
      (data[listKey] as string[]).push(li[1].trim());
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (v === '') {
      data[k] = [];
      listKey = k;
    } else if (v.startsWith('[') && v.endsWith(']')) {
      data[k] = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
      listKey = null;
    } else {
      data[k] = v.replace(/^["']|["']$/g, '');
      listKey = null;
    }
  }
  return { data, body: m[2] };
}

export function walk(dir: string, filter: (file: string) => boolean = () => true, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.obsidian' || e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, filter, out);
    } else if (filter(full)) out.push(full);
  }
  return out;
}

