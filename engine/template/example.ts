// Builds the example company: the starter templates imported into a fresh temp home, as a file tree.
// `company.example/` in the repo is this tree, checked in; a test compares it to a fresh build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, planImport } from './import.ts';
import { BUILTIN_TEMPLATES_DIR } from './load.ts';
import { readTree } from './tree.ts';

/** The ids listed in engine/templates/company-example.json (data). */
export function exampleTemplates(): string[] {
  return (JSON.parse(fs.readFileSync(path.join(BUILTIN_TEMPLATES_DIR, 'company-example.json'), 'utf8')) as { templates: string[] }).templates;
}

export async function buildExampleTree(): Promise<Record<string, string>> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-example-'));
  try {
    const home = path.join(base, 'fleet');
    const plan = await planImport({ home, templates: exampleTemplates() });
    await applyPlan(plan);
    return readTree(home);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
