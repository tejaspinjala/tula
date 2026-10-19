// Task: a unit of work with exactly one owner Agent (PHASE-1-PLAN 3.1, extended in v1.1 with team and
// workflow-instance links).
import { z } from 'zod';
import { dataClass, doneCondition, id, slug, ts, usd } from './common.ts';

export const TASK_STATUSES = ['backlog', 'ready', 'running', 'verify', 'blocked', 'awaiting_approval', 'done', 'cancelled'] as const;
export const TASK_FLAGS = ['external', 'irreversible', 'open_ok', 'overnight', 'hidden_tests', 'urgent'] as const;

export const taskSchema = z
  .strictObject({
    id,
    projectId: z.string().min(1),
    goalId: z.string().min(1),
    departmentId: slug.optional(),
    teamId: slug.optional(),
    workflowInstanceId: id.optional(),
    nodeId: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    sim: z.boolean().optional(),
    parentTaskId: id.optional(),
    title: z.string().min(1).max(140),
    ownerAgentId: slug.describe('exactly one owner'),
    taskType: z.string().min(1).optional().describe('routing key, e.g. post.draft, brain.compile, verify'),
    acceptance: z.array(z.string().min(1)).min(1),
    doneCondition,
    status: z.enum(TASK_STATUSES),
    blockedReason: z
      .enum(['deps', 'provider', 'private_provider_unavailable', 'access', 'approval', 'budget', 'killed', 'other'])
      .optional(),
    priority: z.int().min(0).max(3),
    risk: z.enum(['low', 'high']),
    dataClass,
    flags: z.array(z.enum(TASK_FLAGS)).optional(),
    deps: z.array(id).optional(),
    inputs: z.array(z.string()).optional().describe('file/brain paths, never contents'),
    proposal: z.strictObject({ kind: z.enum(['commit', 'content']), hash: z.string().min(1) }).optional(),
    verdictId: id.optional(),
    approvalId: id.optional(),
    estimateUsd: usd.optional(),
    attempts: z.int().min(0).optional(),
    runIds: z.array(id).optional(),
    dueAt: ts.optional(),
    createdAt: ts,
    updatedAt: ts,
    version: z.int().min(1),
  })
  .superRefine((t, ctx) => {
    if (t.status === 'blocked' && !t.blockedReason) {
      ctx.addIssue({ code: 'custom', path: ['blockedReason'], message: 'a blocked task needs a blockedReason' });
    }
    if (t.nodeId && !t.workflowInstanceId) {
      ctx.addIssue({ code: 'custom', path: ['workflowInstanceId'], message: 'nodeId requires workflowInstanceId' });
    }
  });
export type Task = z.infer<typeof taskSchema>;
