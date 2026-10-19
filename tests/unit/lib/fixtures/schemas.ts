// Tiny hand-written schemas with the same parse() shape as Zod, so these tests do not depend on Zod.
import type { Schema } from '../../../../engine/lib/store.ts';

export interface Counter {
  count: number;
}

export const counterSchema: Schema<Counter> = {
  parse(input: unknown): Counter {
    if (typeof input !== 'object' || input === null) throw new Error('expected object');
    const c = (input as Record<string, unknown>).count;
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) throw new Error('count must be a non-negative integer');
    return { count: c }; // strips unknown keys, like Zod's default object()
  },
};
