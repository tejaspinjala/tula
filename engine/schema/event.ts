// Event: the normalized stream for UI, metrics and replay (PHASE-1-PLAN 3.1, extended in v1.1 with
// workflow / config / connection / manual-action events).
//
// `data` holds type-specific extras. For the v1.1 event types the shape of `data` is defined below in
// EVENT_DATA_SCHEMAS and checked by Zod; older types keep a free-form object. The exported JSON Schema shows
// `data` as a plain object (the per-type check is a Zod refinement, which JSON Schema export does not carry).
import { z } from 'zod';
import { id, sha256, slug, ts } from './common.ts';

export const EVENT_TYPES = [
  'run.start', 'run.end', 'msg.delegate', 'msg.report', 'msg.human', 'tool.call', 'tool.result', 'tool.denied', 'usage',
  'ctx', 'compact', 'handoff', 'error',
  'task.transition', 'approval.requested', 'approval.decided', 'verdict.issued', 'access.requested', 'access.granted',
  'access.escalated',
  'detector.alert', 'schedule.fired', 'kill.on', 'kill.off', 'provider.degraded', 'provider.recovered',
  'workflow.instance.start', 'workflow.node.state', 'workflow.instance.end', 'config.changed', 'config.pending_confirmation',
  'connection.health', 'manual_action.requested', 'manual_action.completed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const nodeStatus = z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'skipped']);

/** Per-type `data` shapes (v1.1 types). Types not listed here accept any object. */
export const EVENT_DATA_SCHEMAS: Partial<Record<EventType, z.ZodType>> = {
  'workflow.instance.start': z.strictObject({
    workflowId: slug,
    workflowVersion: z.int().min(1),
    triggerType: z.string().min(1),
  }),
  'workflow.node.state': z.strictObject({
    status: nodeStatus,
    attempt: z.int().min(0).optional(),
    iteration: z.int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
  }),
  'workflow.instance.end': z.strictObject({
    status: z.enum(['failed', 'done', 'cancelled']),
    costUsd: z.number().min(0).optional(),
  }),
  'config.changed': z.strictObject({
    kind: z.string().min(1),
    id: z.string().min(1),
    version: z.int().min(1),
    hash: sha256,
    effective: z.enum(['now', 'next_run']).optional(),
  }),
  'config.pending_confirmation': z.strictObject({
    kind: z.string().min(1),
    id: z.string().min(1),
    version: z.int().min(1),
    reasons: z.array(z.string()).min(1),
  }),
  'connection.health': z.strictObject({
    connectionId: slug,
    status: z.enum(['ok', 'needs_login', 'rate_limited', 'error', 'unknown']),
  }),
  'manual_action.requested': z.strictObject({
    connectionId: slug,
    actionId: z.string().min(1),
    approvalId: id.optional(),
  }),
  'manual_action.completed': z.strictObject({
    connectionId: slug,
    actionId: z.string().min(1),
    url: z.url().optional(),
    confirmed: z.boolean().optional(),
  }),
};

const WORKFLOW_EVENT_TYPES: readonly EventType[] = ['workflow.instance.start', 'workflow.node.state', 'workflow.instance.end'];

export const eventSchema = z
  .strictObject({
    ts,
    type: z.enum(EVENT_TYPES),
    source: z.enum(['hook', 'adapter', 'otel', 'fleetd', 'gateway', 'ui']),
    runId: id.optional(),
    taskId: id.optional(),
    workflowInstanceId: id.optional(),
    nodeId: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    sim: z.boolean().optional(),
    agentId: z.string().optional(),
    parentAgentId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string().max(400).optional().describe("redacted; private-class text replaced by '[private]' outside private views"),
    tool: z.string().optional(),
    usage: z
      .strictObject({
        model: z.string().optional(),
        in: z.int().min(0).optional(),
        out: z.int().min(0).optional(),
        cacheRead: z.int().min(0).optional(),
        cacheWrite: z.int().min(0).optional(),
        costUsd: z.number().min(0).optional(),
        quotaUnits: z.number().min(0).optional(),
      })
      .optional(),
    ctxPct: z.number().min(0).max(100).optional(),
    data: z.record(z.string(), z.unknown()).optional().describe('type-specific extras, schema per type in engine/schema/event.ts'),
  })
  .superRefine((e, ctx) => {
    const dataSchema = EVENT_DATA_SCHEMAS[e.type];
    if (dataSchema) {
      const r = dataSchema.safeParse(e.data);
      if (!r.success) {
        for (const issue of r.error.issues) {
          ctx.addIssue({ code: 'custom', path: ['data', ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))], message: `${e.type}: ${issue.message}` });
        }
      }
    }
    if (WORKFLOW_EVENT_TYPES.includes(e.type) && !e.workflowInstanceId) {
      ctx.addIssue({ code: 'custom', path: ['workflowInstanceId'], message: `${e.type} needs workflowInstanceId` });
    }
    if (e.type === 'workflow.node.state' && !e.nodeId) {
      ctx.addIssue({ code: 'custom', path: ['nodeId'], message: 'workflow.node.state needs nodeId' });
    }
    if (e.type === 'usage' && !e.usage) {
      ctx.addIssue({ code: 'custom', path: ['usage'], message: 'a usage event needs a usage object' });
    }
  });
export type Event = z.infer<typeof eventSchema>;
