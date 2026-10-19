// Department (config kind `department`, `org/departments/<id>.json`; SPEC 5, 8.4).
import { z } from 'zod';
import { autonomy, dataClass, SLUG_RE, scope, slug } from './common.ts';

export const departmentSchema = z.strictObject({
  id: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(60),
  directorAgentId: slug,
  purpose: z.string().max(300).optional(),
  autonomy,
  envelopeId: z.string().optional(),
  tools: z.array(z.string()).optional().describe('tool policy: tools any role in this department may hold'),
  scope: scope.optional().describe('department ceiling; effective permission = role ∩ team ∩ department ∩ policy ∩ grants'),
  dataClass: dataClass.describe("highest data class handled; 'private' forces fail-closed routing (SPEC 4.8)"),
  goalIds: z.array(z.string().min(1)),
  status: z.enum(['active', 'dormant', 'paused', 'retired']),
  room: z.string().optional().describe('office room label (UI only)'),
});
export type Department = z.infer<typeof departmentSchema>;
