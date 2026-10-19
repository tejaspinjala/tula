// Agent: a named instance of a Role in the org tree (config kind `agent`, `org/agents/<id>.json`; SPEC 5,
// 10.4). The display name is a label only.
import { z } from 'zod';
import { SLUG_RE, slug } from './common.ts';

export const agentSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    displayName: z.string().min(1).max(60),
    roleId: slug,
    parentAgentId: slug.nullable().describe('null only for the top agent under the Owner'),
    departmentId: slug,
    teamId: slug.optional(),
    projectId: z.string().optional(),
    avatar: z.string().optional(),
    namedAfterRealPerson: z.boolean().describe('S4: label only; never used externally or for tone mimicry'),
    status: z.enum(['active', 'paused', 'retired']),
    coachingNoteIds: z.array(z.string()).optional(),
  })
  .superRefine((a, ctx) => {
    if (a.parentAgentId === a.id) ctx.addIssue({ code: 'custom', path: ['parentAgentId'], message: 'an agent cannot be its own parent' });
  });
export type Agent = z.infer<typeof agentSchema>;
