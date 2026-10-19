// Workflow node types (PHASE-1-PLAN 3.2 "Node-type configs", SPEC 27.2).
//
// Each node type has a config schema, emitted as `$defs/<type>` (e.g. `$defs/trigger.schedule`) in
// node-types.schema.json and workflow.schema.json. A workflow node is a discriminated union on `type`, so a
// node's `config` is checked against its own type's schema by Zod itself (the plan's `node.config: object`
// plus "the validator applies $defs[node.type]" becomes one schema here).
//
// Graph-level rules (reachability, cycles, port/type compatibility, binding resolution, scopes, taint, gate
// rule, budget) are NOT here: they belong to the workflow validator (slice P1-W1, SPEC 27.3).
import { z } from 'zod';
import { doneCondition, jsonSchema, scope, secretPathRef, slug, tier } from './common.ts';

export const NODE_TYPES = [
  'trigger.schedule', 'trigger.manual', 'trigger.event', 'trigger.webhook', 'agent', 'verify', 'judge', 'approval', 'action',
  'branch', 'fanout', 'fanin', 'loop', 'wait', 'notify', 'set', 'subworkflow',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const TRIGGER_NODE_TYPES = ['trigger.schedule', 'trigger.manual', 'trigger.event', 'trigger.webhook'] as const;

export const nodeType = z.enum(NODE_TYPES).meta({ id: 'nodeType' });

export const NODE_ID_RE = /^[a-z0-9_-]{1,40}$/;
export const nodeId = z.string().regex(NODE_ID_RE).meta({ id: 'nodeId' });

/** A JSON Logic expression (data only, never code). Arrays are not a valid top-level expression. */
export const jsonLogic = z
  .union([z.record(z.string(), z.unknown()), z.boolean(), z.number(), z.string(), z.null()])
  .meta({ id: 'jsonLogic' });

/** Reference into instance data: `trigger…`, `params…` or `nodes.<id>.output…`. */
export const BINDING_FROM_RE = /^(trigger|params|nodes\.[a-z0-9_-]+\.output)(\.[A-Za-z0-9_]+|\[[0-9]+\])*$/;
export const binding = z
  .union([z.strictObject({ from: z.string().regex(BINDING_FROM_RE) }), z.strictObject({ value: z.unknown() })])
  .meta({ id: 'binding' });

/** A 5-field cron expression (syntax only; semantic parsing is the trigger service's job, P1-T). */
export const CRON_RE = /^(\S+\s+){4}\S+$/;
const cron = z.string().regex(CRON_RE, 'cron must have 5 fields');
const tz = z.string().min(1).describe('IANA time zone, e.g. America/Chicago');
const roleId = slug;

export const nodeConfigSchemas = {
  'trigger.schedule': z
    .strictObject({ cron, tz, catchUp: z.enum(['once', 'skip', 'all']).default('once') })
    .meta({ id: 'trigger.schedule' }),
  'trigger.manual': z.strictObject({ inputSchema: jsonSchema.optional() }).meta({ id: 'trigger.manual' }),
  'trigger.event': z
    .strictObject({ eventType: z.string().min(1), filter: jsonLogic.optional() })
    .meta({ id: 'trigger.event' }),
  'trigger.webhook': z
    .strictObject({ hmacSecretRef: secretPathRef, inputSchema: jsonSchema.optional() })
    .meta({ id: 'trigger.webhook' }),
  agent: z
    .strictObject({
      roleId,
      agentId: slug.optional(),
      tierOverride: tier.optional(),
      briefTemplate: z
        .string()
        .min(1)
        .max(4000)
        .describe('may reference {{inputs.x}}; contents of files are never inlined, only paths'),
      acceptance: z.array(z.string().min(1)).min(1),
      doneCondition,
      skills: z.array(z.string()).optional(),
      narrowScope: scope.optional().describe('intersected with the role scope; can only narrow'),
    })
    .meta({ id: 'agent' }),
  verify: z
    .strictObject({ roleId, proposalFrom: z.string().min(1), rubric: z.string().optional(), hiddenTestsRef: z.string().optional() })
    .meta({ id: 'verify' }),
  judge: z
    .strictObject({
      roleId,
      rubric: z.string().min(1),
      familyPolicy: z.enum(['other_than_implementer', 'any']).default('other_than_implementer'),
      onUnavailable: z.enum(['skip_weak', 'pause']).default('skip_weak'),
    })
    .meta({ id: 'judge' }),
  approval: z
    .strictObject({
      approver: z.string().min(1).describe("'owner' or a roleId"),
      payloadFrom: z.string().min(1),
      expiresHours: z.int().min(1).default(72),
      allowEdit: z.boolean().default(true),
    })
    .meta({ id: 'approval' }),
  action: z
    .strictObject({
      connectionId: slug,
      actionId: z.string().min(1),
      approvalFrom: nodeId.optional().describe('node id of the gating approval'),
    })
    .meta({ id: 'action' }),
  branch: z.strictObject({ condition: jsonLogic }).meta({ id: 'branch' }),
  fanout: z
    .strictObject({
      over: z.string().optional(),
      branches: z.int().min(2).max(10).optional(),
      maxParallel: z.int().min(1).default(3),
    })
    .refine((c) => (c.over === undefined) !== (c.branches === undefined), {
      message: 'fanout needs exactly one of `over` or `branches`',
      path: ['over'],
    })
    .meta({ id: 'fanout' }),
  fanin: z
    .strictObject({ mode: z.enum(['all', 'any', 'n_of']), n: z.int().min(1).optional() })
    .refine((c) => (c.mode === 'n_of') === (c.n !== undefined), { message: '`n` is required for, and only for, mode n_of', path: ['n'] })
    .meta({ id: 'fanin' }),
  loop: z
    .strictObject({
      forEach: z.string().optional(),
      until: jsonLogic.optional(),
      maxIterations: z.int().min(1).max(20),
      maxUsd: z.number().min(0),
    })
    .refine((c) => c.forEach !== undefined || c.until !== undefined, { message: 'loop needs `forEach` or `until`', path: ['forEach'] })
    .meta({ id: 'loop' }),
  wait: z
    .strictObject({
      durationSec: z.int().min(1).optional(),
      untilCron: cron.optional(),
      untilEvent: z.string().optional(),
      timeoutSec: z.int().min(1).optional(),
    })
    .refine((c) => c.durationSec !== undefined || c.untilCron !== undefined || c.untilEvent !== undefined, {
      message: 'wait needs durationSec, untilCron or untilEvent',
      path: ['durationSec'],
    })
    .meta({ id: 'wait' }),
  notify: z
    .strictObject({ message: z.string().min(1).max(300), priority: z.enum(['low', 'default', 'high']).optional() })
    .meta({ id: 'notify' }),
  set: z.strictObject({ mapping: z.record(z.string(), jsonLogic) }).meta({ id: 'set' }),
  subworkflow: z.strictObject({ workflowId: slug, version: z.int().min(1) }).meta({ id: 'subworkflow' }),
} as const satisfies Record<NodeType, z.ZodType>;

const nodeBase = {
  id: nodeId,
  label: z.string().max(60).optional(),
  position: z.strictObject({ x: z.number().optional(), y: z.number().optional() }).optional(),
  inputs: z.record(z.string(), binding).optional(),
  outputSchema: jsonSchema.optional().describe("JSON Schema of this node's output"),
  retry: z.strictObject({ max: z.int().min(0).max(5).optional(), backoffSec: z.int().min(1).optional() }).optional(),
  onError: z.enum(['fail', 'edge']).optional(),
  maxUsd: z.number().min(0).optional(),
};

function nodeVariant<T extends NodeType>(type: T) {
  return z.strictObject({ ...nodeBase, type: z.literal(type), config: nodeConfigSchemas[type] });
}

/** One workflow node; `config` is validated against the schema of its `type`. */
export const workflowNodeSchema = z
  .discriminatedUnion('type', [
    nodeVariant('trigger.schedule'), nodeVariant('trigger.manual'), nodeVariant('trigger.event'), nodeVariant('trigger.webhook'),
    nodeVariant('agent'), nodeVariant('verify'), nodeVariant('judge'), nodeVariant('approval'), nodeVariant('action'),
    nodeVariant('branch'), nodeVariant('fanout'), nodeVariant('fanin'), nodeVariant('loop'), nodeVariant('wait'),
    nodeVariant('notify'), nodeVariant('set'), nodeVariant('subworkflow'),
  ])
  .meta({ id: 'node' });
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

/** Registry entry `node-types`: a single workflow node (fixtures in tests/fixtures/schema/node-types/). */
export const nodeTypesSchema = workflowNodeSchema;
export type NodeTypes = WorkflowNode;
