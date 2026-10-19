// Shared, zero-dependency helpers for hooks, scripts and the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const root = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();
export const p = (...parts) => path.join(root(), ...parts);
export const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
export const clip = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function readStdin() {
  try {
    const s = fs.readFileSync(0, 'utf8');
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export function loadJSON(rel) {
  return JSON.parse(fs.readFileSync(p(rel), 'utf8'));
}

export function appendEvent(ev) {
  const f = p('fleet', 'state', 'events.jsonl');
  ensureDir(path.dirname(f));
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n');
}

export function readJSONState(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p('fleet', 'state', name), 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJSONState(name, data) {
  const f = p('fleet', 'state', name);
  ensureDir(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify(data));
}

export const sha = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

// Minimal frontmatter parser: `key: value`, `key: [a, b]`, and `key:` + `- item` lists.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (li && listKey) {
      data[listKey].push(li[1].trim());
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

export function walk(dir, filter = () => true, out = []) {
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

