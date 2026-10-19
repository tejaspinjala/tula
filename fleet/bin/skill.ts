#!/usr/bin/env bun
// Section-level skill loader. Skills live in fleet/skills/<name>/SKILL.md and are NOT registered with
// Claude's skill listing (zero standing token cost). Agents pull only what the task needs:
//   skill.ts <name>                  core + section index (small)
//   skill.ts <name> --section "Errors"   one section
//   skill.ts --list                  one line per skill
import fs from 'node:fs';
import { p, parseFrontmatter, walk } from '../lib/core.ts';

export function splitSkill(text) {
  const { data, body } = parseFrontmatter(text);
  const parts = body.split(/^## /m);
  const core = parts.shift().replace(/^# .*\n?/, '').trim();
  const sections = parts.map((s) => {
    const nl = s.indexOf('\n');
    return { title: s.slice(0, nl).trim(), body: s.slice(nl + 1).trim() };
  });
  return { data, core, sections };
}

export function loadSkill(name) {
  const f = p('fleet', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(f)) throw new Error(`unknown skill "${name}" (try --list)`);
  return splitSkill(fs.readFileSync(f, 'utf8'));
}

export function render(name, { section } = {}) {
  const s = loadSkill(name);
  if (section) {
    const hit = s.sections.find((x) => x.title.toLowerCase().startsWith(section.toLowerCase()));
    if (!hit) throw new Error(`no section "${section}" in ${name}. Sections: ${s.sections.map((x) => x.title).join(' | ')}`);
    return `## ${hit.title}\n${hit.body}`;
  }
  const idx = s.sections.map((x) => `- ${x.title}: ${x.body.split('\n')[0].slice(0, 90)}`).join('\n');
  return `${s.core}\n\nSections (load with --section "<name>"):\n${idx}`;
}

export function listSkills() {
  return walk(p('fleet', 'skills'), (f) => f.endsWith('SKILL.md')).map((f) => {
    const { data } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    return `${data.name}: ${data.description}`;
  });
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === '--list' || a.length === 0) console.log(listSkills().join('\n'));
    else {
      const i = a.indexOf('--section');
      const out = render(a[0], { section: i >= 0 ? a[i + 1] : undefined });
      console.log(out);
      console.error(`[~${Math.ceil(out.length / 4)} tokens]`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
