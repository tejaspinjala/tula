#!/usr/bin/env bun
// Token-lean orientation: on startup/resume/compact, inject a few POINTERS (never contents).
import fs from 'node:fs';
import path from 'node:path';
import type { HookEvent } from '../lib/core.ts';
import { readStdin, p } from '../lib/core.ts';

export function latestHandoff(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  return files.length ? path.join('brain', 'runs', files[files.length - 1]) : null; // no-hardcode-ok: layout path
}

export function contextFor(ev: HookEvent, dir: string = p('brain', 'runs')): string { // no-hardcode-ok: layout path
  const lines = ['Company brain: brain/00-INDEX.md (read it only when you need company context; follow links, do not read the vault wholesale).'];
  if (['compact', 'resume'].includes(ev.source ?? '')) {
    const h = latestHandoff(dir);
    if (h) lines.push(`Last handoff: ${h}. Read it first, then continue from "Next".`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const ev = readStdin();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contextFor(ev) },
  }));
}
