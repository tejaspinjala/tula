#!/usr/bin/env bun
// Section-level skill loader. Skills live in engine/skills/<name>/SKILL.md and are NOT registered with
// Claude's skill listing (zero standing token cost). Agents pull only what the task needs:
//   skill.ts <name>                  core + section index (small)
//   skill.ts <name> --index          section index only (no core text)
//   skill.ts <name> --section "Errors"   one section
//   skill.ts --list                  one line per skill
import fs from 'node:fs';
import { p, parseFrontmatter, walk } from '../lib/core.ts';

export interface SkillSection {
  title: string;
  body: string;
}

export interface Skill {
  data: Record<string, string | string[]>;
  core: string;
  sections: SkillSection[];
}

export function splitSkill(text: string): Skill {
  const { data, body } = parseFrontmatter(text);
  const parts = body.split(/^## /m);
  const core = (parts.shift() ?? '').replace(/^# .*\n?/, '').trim();
  const sections = parts.map((s) => {
    const nl = s.indexOf('\n');
    return { title: s.slice(0, nl).trim(), body: s.slice(nl + 1).trim() };
  });
  return { data, core, sections };
}

export function loadSkill(name: string): Skill {
  const f = p('engine', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(f)) throw new Error(`unknown skill "${name}" (try --list)`);
  return splitSkill(fs.readFileSync(f, 'utf8'));
}

function indexOf(s: Skill): string {
  return s.sections.map((x) => `- ${x.title}: ${x.body.split('\n')[0].slice(0, 90)}`).join('\n');
}

export function render(name: string, { section, index }: { section?: string; index?: boolean } = {}): string {
  const s = loadSkill(name);
  if (index) return `Sections (load with --section "<name>"):\n${indexOf(s)}`;
  if (section) {
    const hit = s.sections.find((x) => x.title.toLowerCase().startsWith(section.toLowerCase()));
    if (!hit) throw new Error(`no section "${section}" in ${name}. Sections: ${s.sections.map((x) => x.title).join(' | ')}`);
    return `## ${hit.title}\n${hit.body}`;
  }
  return `${s.core}\n\nSections (load with --section "<name>"):\n${indexOf(s)}`;
}

export function listSkills(): string[] {
  return walk(p('engine', 'skills'), (f: string) => f.endsWith('SKILL.md')).map((f) => {
    const { data } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    return `${data.name}: ${data.description}`;
  });
}

/** Runs the CLI for `argv` (without bun/script) and returns what should be printed. Throws on user errors. */
export function cli(a: string[]): string {
  if (a[0] === '--list' || a.length === 0) return listSkills().join('\n');
  const i = a.indexOf('--section');
  return render(a[0] as string, { section: i >= 0 ? a[i + 1] : undefined, index: a.includes('--index') });
}

if (import.meta.main) {
  try {
    const out = cli(process.argv.slice(2));
    console.log(out);
    if (process.argv.length > 2 && process.argv[2] !== '--list') console.error(`[~${Math.ceil(out.length / 4)} tokens]`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
