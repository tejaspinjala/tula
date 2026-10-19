// Workflow: a versioned JSON graph of typed nodes (PHASE-1-PLAN 3.2, SPEC 27). One file per workflow
// version in $FLEET_HOME/workflows/.
//
// Checked here (what a schema can express): node/edge shapes, per-type node configs, unique node and edge
// ids, edges that point at existing nodes, at least one trigger node. NOT checked here (P1-W1 validator):
// reachability, cycles, port semantics per node type, binding resolution and types, refs, scopes, taint,
// the gate rule, budgets, risk classification.
import { z } from 'zod';
import { jsonSchema, SLUG_RE, slug, ts } from './common.ts';
import { TRIGGER_NODE_TYPES, workflowNodeSchema } from './node-types.ts';

export const EDGE_PORTS = ['default', 'true', 'false', 'error', 'each', 'done'] as const;

export const edge = z
  .strictObject({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    port: z.enum(EDGE_PORTS).optional(),
  })
  .meta({ id: 'edge' });
export type WorkflowEdge = z.infer<typeof edge>;

export const workflowSchema = z
  .strictObject({
    id: z.string().regex(SLUG_RE),
    version: z.int().min(1),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    teamId: slug.optional(),
    params: jsonSchema.optional().describe('JSON Schema for instance/template params'),
    status: z.enum(['draft', 'active', 'archived', 'pending_confirmation']),
    nodes: z.array(workflowNodeSchema).min(2),
    edges: z.array(edge),
    limits: z
      .strictObject({
        maxUsdPerInstance: z.number().min(0).optional(),
        maxConcurrentInstances: z.int().min(1).optional(),
      })
      .optional(),
    createdBy: z.string().optional(),
    updatedAt: ts.optional(),
  })
  .superRefine((w, ctx) => {
    const nodeIds = new Set<string>();
    w.nodes.forEach((n, i) => {
      if (nodeIds.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate node id '${n.id}'` });
      nodeIds.add(n.id);
    });
    const edgeIds = new Set<string>();
    w.edges.forEach((e, i) => {
      if (edgeIds.has(e.id)) ctx.addIssue({ code: 'custom', path: ['edges', i, 'id'], message: `duplicate edge id '${e.id}'` });
      edgeIds.add(e.id);
      if (!nodeIds.has(e.from)) ctx.addIssue({ code: 'custom', path: ['edges', i, 'from'], message: `edge from unknown node '${e.from}'` });
      if (!nodeIds.has(e.to)) ctx.addIssue({ code: 'custom', path: ['edges', i, 'to'], message: `edge to unknown node '${e.to}'` });
    });
    if (!w.nodes.some((n) => (TRIGGER_NODE_TYPES as readonly string[]).includes(n.type))) {
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'a workflow needs at least one trigger node' });
    }
  });
export type Workflow = z.infer<typeof workflowSchema>;
