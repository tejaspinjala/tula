// Reads a config tree (relative path -> file text) for comparisons: ignores git internals and service-owned state.
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_TOP = new Set(['.git', '.gitignore', 'state', 'host.json', 'STOP']);

export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (!rel && IGNORED_TOP.has(d.name)) continue;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && !d.name.endsWith('.lock') && !d.name.startsWith('.')) out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function writeTree(dir: string, tree: Record<string, string>): void {
  for (const [rel, text] of Object.entries(tree)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}
