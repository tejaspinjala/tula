// Template params: typed values (JSON Schema subset), defaults, and `{{param}}` substitution.
// Substitution works on string VALUES of the parsed JSON (never on keys, never on raw text), so a param value
// can not break the JSON structure. A string that is exactly `{{name}}` keeps the param's type (number/boolean).
// Filters: `{{name|slug}}` lower-cases and turns anything but letters/digits into single dashes.
import { TemplateError } from './errors.ts';

export type ParamValue = string | number | boolean;
export type ParamValues = Record<string, ParamValue>;

interface Decl {
  type: 'string' | 'number' | 'integer' | 'boolean';
  default?: ParamValue;
  enum?: ParamValue[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function coerce(name: string, d: Decl, raw: unknown): ParamValue {
  let v: unknown = raw;
  if (typeof raw === 'string' && d.type !== 'string') {
    if (d.type === 'boolean') {
      if (raw === 'true') v = true;
      else if (raw === 'false') v = false;
    } else if (raw.trim() !== '' && !Number.isNaN(Number(raw))) v = Number(raw);
  }
  const typeOk = d.type === 'integer' ? Number.isInteger(v) : typeof v === d.type;
  if (!typeOk) throw new TemplateError(`param '${name}' must be of type ${d.type}, got ${JSON.stringify(raw)}`);
  const val = v as ParamValue;
  if (d.enum && !d.enum.includes(val)) throw new TemplateError(`param '${name}' must be one of ${d.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(val)}`);
  if (typeof val === 'string') {
    if (d.pattern && !new RegExp(d.pattern).test(val)) throw new TemplateError(`param '${name}' does not match ${d.pattern}`);
    if (d.minLength !== undefined && val.length < d.minLength) throw new TemplateError(`param '${name}' is shorter than ${d.minLength}`);
    if (d.maxLength !== undefined && val.length > d.maxLength) throw new TemplateError(`param '${name}' is longer than ${d.maxLength}`);
  }
  if (typeof val === 'number') {
    if (d.minimum !== undefined && val < d.minimum) throw new TemplateError(`param '${name}' is below ${d.minimum}`);
    if (d.maximum !== undefined && val > d.maximum) throw new TemplateError(`param '${name}' is above ${d.maximum}`);
  }
  return val;
}

/** Resolves supplied values against the declaration: defaults, types, enums, required, unknown names. */
export function resolveParams(templateId: string, decl: Record<string, unknown> | undefined, supplied: Record<string, unknown>): ParamValues {
  const props = ((decl?.properties ?? {}) as Record<string, Decl>);
  const required = new Set(((decl?.required ?? []) as string[]));
  const unknown = Object.keys(supplied).filter((k) => !(k in props));
  if (unknown.length) throw new TemplateError(`template '${templateId}': unknown param(s) ${unknown.map((u) => `'${u}'`).join(', ')}`, [`declared: ${Object.keys(props).join(', ') || '(none)'}`]);
  const out: ParamValues = {};
  const missing: string[] = [];
  for (const [name, d] of Object.entries(props)) {
    if (name in supplied) out[name] = coerce(name, d, supplied[name]);
    else if ('default' in d && d.default !== undefined) out[name] = d.default;
    else if (required.has(name)) missing.push(name);
  }
  if (missing.length) throw new TemplateError(`template '${templateId}': missing required param(s) ${missing.map((m) => `'${m}'`).join(', ')} (pass --param ${missing[0]}=...)`);
  return out;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}/g;
const WHOLE = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|\s*([A-Za-z0-9]+)\s*)?\}\}$/;

function applyFilter(v: ParamValue, filter: string | undefined, where: string): ParamValue {
  if (!filter) return v;
  if (filter === 'slug') return slugify(String(v));
  throw new TemplateError(`unknown filter '${filter}' at ${where}`);
}

/** Replaces `{{name}}` in every string of `value`. A placeholder with no value is an error naming where it is. */
export function substitute(value: unknown, params: ParamValues, where = '$'): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      const v = params[whole[1]!];
      if (v === undefined) throw new TemplateError(`unresolved placeholder {{${whole[1]}}} at ${where}`);
      return applyFilter(v, whole[2], where);
    }
    return value.replace(PLACEHOLDER, (_m, name: string, filter?: string) => {
      const v = params[name];
      if (v === undefined) throw new TemplateError(`unresolved placeholder {{${name}}} at ${where}`);
      return String(applyFilter(v, filter, where));
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, params, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, params, `${where}.${k}`)]));
  }
  return value;
}

/** Placeholder names used anywhere in `value` (for the "undeclared param" check at load time). */
export function placeholders(value: unknown, acc = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) acc.add(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, acc));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => placeholders(v, acc));
  return acc;
}
