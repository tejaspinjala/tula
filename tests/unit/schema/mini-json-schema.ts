// A deliberately small JSON Schema 2020-12 validator for the keyword subset that z.toJSONSchema emits for
// engine/schema. Used only by tests to round-trip fixtures through the exported JSON Schema without adding
// a validator dependency. Any keyword it does not know makes it throw, so a new keyword in the export can't
// be silently ignored.
type Schema = Record<string, unknown> | boolean;

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'description', 'default', 'title', 'x-ownerLocked',
  'type', 'enum', 'const', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'properties', 'required', 'additionalProperties', 'propertyNames', 'items', 'minItems', 'maxItems',
  'anyOf', 'oneOf', 'allOf',
]);

export interface ValidationError {
  path: string;
  message: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  return want === got || (want === 'number' && got === 'integer');
}

export function validate(root: Record<string, unknown>, value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const defs = (root.$defs ?? {}) as Record<string, Schema>;

  function resolve(ref: string): Schema {
    const m = /^#\/\$defs\/(.+)$/.exec(ref);
    if (!m || !(m[1] in defs)) throw new Error(`unresolvable $ref ${ref}`);
    return defs[m[1]];
  }

  function check(schema: Schema, v: unknown, path: string, out: ValidationError[]): void {
    if (schema === true) return;
    if (schema === false) {
      out.push({ path, message: 'false schema' });
      return;
    }
    for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`mini validator: unsupported keyword '${k}' at ${path}`);
    const s = schema as Record<string, any>;
    const fail = (message: string): void => {
      out.push({ path, message });
    };

    if (s.$ref) check(resolve(s.$ref), v, path, out);
    if (s.type !== undefined) {
      const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => typeMatches(t, v))) return fail(`expected ${types.join('|')}, got ${typeOf(v)}`);
    }
    if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) fail(`not in enum`);
    if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) fail(`not const ${JSON.stringify(s.const)}`);
    if (typeof v === 'string') {
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) fail(`does not match ${s.pattern}`);
      if (s.minLength !== undefined && [...v].length < s.minLength) fail('too short');
      if (s.maxLength !== undefined && [...v].length > s.maxLength) fail('too long');
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) fail('below minimum');
      if (s.maximum !== undefined && v > s.maximum) fail('above maximum');
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) fail('not above exclusiveMinimum');
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) fail('not below exclusiveMaximum');
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) fail('too few items');
      if (s.maxItems !== undefined && v.length > s.maxItems) fail('too many items');
      if (s.items !== undefined) v.forEach((item, i) => check(s.items, item, `${path}/${i}`, out));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in obj)) out.push({ path: `${path}/${r}`, message: 'required' });
      for (const [k, val] of Object.entries(obj)) {
        if (s.propertyNames) check(s.propertyNames, k, `${path}/${k}#name`, out);
        if (k in props) check(props[k], val, `${path}/${k}`, out);
        else if (s.additionalProperties !== undefined) check(s.additionalProperties, val, `${path}/${k}`, out);
      }
    }
    if (s.allOf) for (const sub of s.allOf) check(sub, v, path, out);
    if (s.anyOf || s.oneOf) {
      const subs: Schema[] = s.anyOf ?? s.oneOf;
      const passing = subs.filter((sub) => {
        const tmp: ValidationError[] = [];
        check(sub, v, path, tmp);
        return tmp.length === 0;
      }).length;
      if (s.anyOf && passing === 0) fail('matches no anyOf branch');
      if (s.oneOf && passing !== 1) fail(`matches ${passing} oneOf branches (want exactly 1)`);
    }
  }

  check(root, value, '', errors);
  return errors;
}
