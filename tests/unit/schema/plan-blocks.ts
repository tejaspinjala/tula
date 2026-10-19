// Extracts the JSON contract blocks from docs/PHASE-1-PLAN.md section 3 and compares them with the exported
// JSON Schema by property names and required sets.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../helpers.ts';

export type Json = Record<string, any>;

export function planSection3Blocks(): Json[] {
  const md = fs.readFileSync(path.join(repoRoot, 'docs', 'PHASE-1-PLAN.md'), 'utf8');
  const start = md.indexOf('\n## 3. ');
  const end = md.indexOf('\n## 4. ');
  if (start < 0 || end < 0) throw new Error('PHASE-1-PLAN.md: section 3 not found');
  const section = md.slice(start, end);
  return [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m, i) => {
    try {
      return JSON.parse(m[1]) as Json;
    } catch (e) {
      throw new Error(`PHASE-1-PLAN.md section 3, json block #${i + 1} is not valid JSON: ${(e as Error).message}`);
    }
  });
}

/** Follows a top-level `$ref: #/$defs/x` so a registered root (node-types) compares like an inline one. */
export function deref(root: Json, s: Json | undefined): Json | undefined {
  let cur = s;
  for (let i = 0; cur && typeof cur.$ref === 'string' && i < 10; i++) {
    const m = /^#\/\$defs\/(.+)$/.exec(cur.$ref);
    cur = m ? root.$defs?.[m[1]] : undefined;
  }
  return cur;
}

export interface Shape {
  properties: string[];
  required: string[];
}

export function shapeOf(s: Json | undefined): Shape {
  return { properties: Object.keys(s?.properties ?? {}).sort(), required: [...(s?.required ?? [])].sort() };
}

/** For a oneOf/anyOf of objects sharing a shape (workflow node variants), the union of their shapes. */
export function unionShape(root: Json, s: Json | undefined): Shape {
  const d = deref(root, s);
  const branches: Json[] = d?.oneOf ?? d?.anyOf ?? [d];
  const props = new Set<string>();
  let required: string[] | undefined;
  for (const b of branches.map((x) => deref(root, x))) {
    Object.keys(b?.properties ?? {}).forEach((k) => props.add(k));
    const req: string[] = b?.required ?? [];
    required = required === undefined ? [...req] : required.filter((r) => req.includes(r));
  }
  return { properties: [...props].sort(), required: [...(required ?? [])].sort() };
}

export interface ShapeDiff {
  addedProperties: string[];
  removedProperties: string[];
  addedRequired: string[];
  removedRequired: string[];
}

export function diffShape(plan: Shape, exported: Shape): ShapeDiff {
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  return {
    addedProperties: minus(exported.properties, plan.properties),
    removedProperties: minus(plan.properties, exported.properties),
    addedRequired: minus(exported.required, plan.required),
    removedRequired: minus(plan.required, exported.required),
  };
}

export const NO_DIFF: ShapeDiff = { addedProperties: [], removedProperties: [], addedRequired: [], removedRequired: [] };

function branches(root: Json, s: Json | undefined): Json[] {
  const d = deref(root, s);
  if (!d) return [];
  return (d.oneOf ?? d.anyOf ?? [d]).map((b: Json) => deref(root, b)).filter(Boolean);
}

function childProp(root: Json, s: Json | undefined, key: string): Json | undefined {
  return branches(root, s).find((b) => b.properties && key in b.properties)?.properties[key];
}

function isEmpty(d: ShapeDiff): boolean {
  return Object.values(d).every((x) => x.length === 0);
}

/**
 * Walks every inline object in a plan schema (properties, items, additionalProperties, oneOf branches, $defs)
 * and records where the exported schema has different property names or required sets. `$ref`s to other
 * definitions are not followed (each definition is compared where it is defined). Paths look like
 * `/properties/auth/properties/secretRefs/items`.
 */
export function compareDeep(planRoot: Json, exRoot: Json, defRename: Record<string, string> = {}): Record<string, ShapeDiff | 'missing'> {
  const out: Record<string, ShapeDiff | 'missing'> = {};
  const walk = (plan: Json, ex: Json | undefined, p: string) => {
    if (!plan || typeof plan !== 'object' || typeof plan.$ref === 'string') return;
    if (!deref(exRoot, ex)) {
      out[p] = 'missing';
      return;
    }
    if (plan.properties) {
      const d = diffShape(shapeOf(plan), unionShape(exRoot, ex));
      if (!isEmpty(d)) out[p] = d;
      for (const [k, child] of Object.entries(plan.properties as Record<string, Json>)) {
        const exChild = childProp(exRoot, ex, k);
        if (exChild) walk(child, exChild, `${p}/properties/${k}`);
      }
    }
    const e = deref(exRoot, ex)!;
    if (plan.items) walk(plan.items, e.items, `${p}/items`);
    if (plan.additionalProperties && typeof plan.additionalProperties === 'object') {
      walk(plan.additionalProperties, e.additionalProperties, `${p}/additionalProperties`);
    }
    const planAlts: Json[] | undefined = plan.oneOf ?? plan.anyOf;
    if (planAlts) {
      const exAlts = branches(exRoot, ex);
      planAlts.forEach((alt, i) => walk(alt, exAlts[i], `${p}/oneOf/${i}`));
    }
  };
  walk(planRoot, exRoot, '');
  for (const [k, def] of Object.entries((planRoot.$defs ?? {}) as Record<string, Json>)) {
    const name = defRename[k] ?? k;
    const exDef = exRoot.$defs?.[name];
    if (!exDef) out[`/$defs/${k}`] = 'missing';
    else walk(def, exDef, `/$defs/${k}`);
  }
  return out;
}
