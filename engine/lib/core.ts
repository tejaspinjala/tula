// Shared, zero-dependency helpers for hooks, scripts and the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Shape of the JSON a Claude Code hook receives on stdin. Only fields we read are listed. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
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

export function appendEvent(ev: Record<string, unknown>): void {
  const f = p('engine', 'state', 'events.jsonl');
  ensureDir(path.dirname(f));
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n');
}

export function readJSONState<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p('engine', 'state', name), 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJSONState(name: string, data: unknown): void {
  const f = p('engine', 'state', name);
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(data));
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

