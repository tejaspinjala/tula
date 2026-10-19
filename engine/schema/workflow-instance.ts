// WorkflowInstance: one execution of a pinned Workflow version (PHASE-1-PLAN 3.2, SPEC 27.1/27.5).
import { z } from 'zod';
import { id, slug, ts } from './common.ts';
import { NODE_ID_RE } from './node-types.ts';

export const nodeState = z
  .strictObject({
    status: z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'skipped']),
    attempts: z.int().min(0).optional(),
    iteration: z.int().min(0).optional(),
    idempotencyKey: z.string().min(1).optional().describe('instanceId:nodeId:iteration'),
    taskId: id.optional(),
    approvalId: id.optional(),
    output: z.unknown().optional(),
    costUsd: z.number().min(0).optional(),
    startedAt: ts.optional(),
    endedAt: ts.optional(),
  })
  .meta({ id: 'nodeState' });

export const workflowInstanceSchema = z
  .strictObject({
    id,
    workflowId: slug,
    workflowVersion: z.int().min(1),
    status: z.enum(['running', 'waiting', 'paused_killed', 'failed', 'done', 'cancelled']),
    trigger: z.strictObject({ type: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() }),
    params: z.record(z.string(), z.unknown()).optional(),
    nodeStates: z.record(z.string().regex(NODE_ID_RE), nodeState),
    sim: z.boolean(),
    costUsd: z.number().min(0).optional(),
    startedAt: ts,
    endedAt: ts.optional(),
  })
  .superRefine((w, ctx) => {
    const terminal = w.status === 'done' || w.status === 'failed' || w.status === 'cancelled';
    if (terminal && !w.endedAt) ctx.addIssue({ code: 'custom', path: ['endedAt'], message: `status '${w.status}' needs endedAt` });
    if (!terminal && w.endedAt) ctx.addIssue({ code: 'custom', path: ['endedAt'], message: `status '${w.status}' cannot have endedAt` });
  });
export type WorkflowInstance = z.infer<typeof workflowInstanceSchema>;
