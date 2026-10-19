// Finding and reading template packages (a directory with template.json + data files). Pure data; no code is run.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from '../lib/paths.ts';
import { templateSchema, type Template } from '../schema/template.ts';
import { TemplateError } from './errors.ts';

/** The packages that ship with the engine (DATA only). */
export const BUILTIN_TEMPLATES_DIR = path.resolve(import.meta.dir, '..', 'templates');

export interface TemplateFile {
  kind: string;
  path: string;
  /** parsed JSON, placeholders not yet substituted */
  raw: unknown;
}

export interface LoadedTemplate {
  dir: string;
  manifest: Template;
  files: TemplateFile[];
}

function parseJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new TemplateError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new TemplateError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export function loadTemplateDir(dir: string): LoadedTemplate {
  const abs = path.resolve(dir);
  const manifestFile = path.join(abs, 'template.json');
  if (!fs.existsSync(manifestFile)) throw new TemplateError(`no template.json in ${abs}`);
  const parsed = templateSchema.safeParse(parseJson(manifestFile));
  if (!parsed.success) {
    throw new TemplateError(`${manifestFile} is not a valid template`, parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const manifest = parsed.data;
  const root = fs.realpathSync(abs);
  const files = manifest.files.map((f) => {
    let full: string;
    try {
      full = resolveInside(root, f.path);
    } catch (e) {
      throw new TemplateError(`template '${manifest.id}': file path '${f.path}' is not allowed: ${(e as Error).message}`);
    }
    return { kind: f.kind, path: f.path, raw: parseJson(full) };
  });
  return { dir: abs, manifest, files };
}

/** `ref` is a template id (looked up as `<root>/<id>/template.json` in each root, built-ins last) or a directory path. */
export function findTemplate(ref: string, roots: string[] = []): LoadedTemplate {
  if (ref.includes('/') || ref.startsWith('.')) return loadTemplateDir(ref);
  for (const root of [...roots, BUILTIN_TEMPLATES_DIR]) {
    const dir = path.join(root, ref);
    if (fs.existsSync(path.join(dir, 'template.json'))) {
      const t = loadTemplateDir(dir);
      if (t.manifest.id !== ref) throw new TemplateError(`${dir}/template.json has id '${t.manifest.id}', expected '${ref}'`);
      return t;
    }
  }
  throw new TemplateError(`template '${ref}' not found`, [`searched: ${[...roots, BUILTIN_TEMPLATES_DIR].join(', ')}`]);
}

export function listBuiltinTemplates(roots: string[] = []): string[] {
  const ids = new Set<string>();
  for (const root of [...roots, BUILTIN_TEMPLATES_DIR]) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'template.json'))) ids.add(d.name);
    }
  }
  return [...ids].sort();
}
