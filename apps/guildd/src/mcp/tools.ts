import { z } from 'zod'
import { unsafeLink } from '../verdict'

/** The MCP spec revision the gateway speaks (stateless: no session, every call stands alone). */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

/** The lease handle a Member passes to every tool after claiming: Quest, attempt (the fencing token) and token. */
export const leaseHandle = z.strictObject({
  questId: z.uuid(),
  attempt: z.number().int().min(1),
  token: z.string().min(1).max(2000),
})
/** A lease handle. */
export type LeaseHandle = z.infer<typeof leaseHandle>

/** Largest artifact a tool moves, decoded. */
export const MAX_TOOL_ARTIFACT_BYTES = 1024 * 1024

/** Arguments of `claim_quest`. */
export const claimQuestArgs = z.strictObject({ assignment: z.string().min(1).max(2000) })
/** Arguments of `read_archive`: one note by id, or a search of the Hall's notes. */
export const readArchiveArgs = z.strictObject({
  lease: leaseHandle,
  noteId: z.uuid().optional(),
  query: z.string().trim().max(200).optional(),
  after: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(50).default(20),
})
/** Arguments of `read_brief`: the lease alone; the Brief is a function of the leased Quest. */
export const readBriefArgs = z.strictObject({ lease: leaseHandle })
/** Arguments of `write_archive`. */
export const writeArchiveArgs = z.strictObject({
  lease: leaseHandle,
  title: z.string().trim().min(1).max(150),
  body: z.string().min(1).max(20000),
  claim: z.enum(['fact', 'assumption']),
  evidence: z.string().trim().min(1).max(2000).optional(),
})
/** Arguments of `get_artifact`. */
export const getArtifactArgs = z.strictObject({
  lease: leaseHandle,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
})
/** Arguments of `put_artifact`. */
export const putArtifactArgs = z.strictObject({
  lease: leaseHandle,
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MAX_TOOL_ARTIFACT_BYTES * 4) / 3) + 4),
})
/** Most Proposals one Quest may hold; past it `submit_proposal` refuses with `proposal_cap`. */
export const MAX_PROPOSALS_PER_QUEST = 10
/** Most evidence links one Proposal carries. */
export const MAX_EVIDENCE_LINKS = 10
/** Arguments of `submit_proposal`: the draft text and the https links that back it. */
export const submitProposalArgs = z.strictObject({
  lease: leaseHandle,
  text: z.string().min(1).max(20000),
  evidenceLinks: z
    .array(
      z
        .string()
        .max(2000)
        .regex(/^https:\/\/[^\s]+$/)
        .refine((link) => !unsafeLink(link))
    )
    .max(MAX_EVIDENCE_LINKS),
})
/**
 * Arguments of `spawn_subquest`: a title, the brief (which becomes the Sub-Quest's done-condition),
 * a Quest template, and optionally another Hall (the parent's own by default).
 */
export const spawnSubquestArgs = z.strictObject({
  lease: leaseHandle,
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(2000),
  template: z.string().min(1).max(64),
  hall: z.string().min(1).max(64).optional(),
})
/** How `await_children` waits: for every Sub-Quest (the default) or the first one done. */
export const awaitChildrenArgs = z.strictObject({
  lease: leaseHandle,
  mode: z.enum(['all', 'any']).default('all'),
})
/** Arguments of `child_results`: the lease alone. */
export const childResultsArgs = z.strictObject({ lease: leaseHandle })
/** Arguments of `complete_quest`; the Handoff is checked separately, for an actionable error. */
export const completeQuestArgs = z.strictObject({ lease: leaseHandle, handoff: z.unknown() })

/** One tool of the catalogue: its name, what it does, and the arguments it accepts. */
export interface ToolDef {
  name: string
  description: string
  /** The roles (ranks) that get this tool. */
  roles: readonly string[]
  args: z.ZodType
}

const ALL_ROLES = ['apprentice', 'journeyman', 'adept']
const SENIOR_ROLES = ['journeyman', 'adept']

/** Every tool of this slice, in the order a role's list shows them. */
export const TOOL_CATALOG: readonly ToolDef[] = [
  {
    name: 'claim_quest',
    roles: ALL_ROLES,
    description: 'Claim the assigned Quest; returns the lease handle and the Brief.',
    args: claimQuestArgs,
  },
  {
    name: 'read_brief',
    roles: ALL_ROLES,
    description:
      'Read the deterministic Brief for the leased Quest (ids, done-condition and Archive pointers only).',
    args: readBriefArgs,
  },
  {
    name: 'read_archive',
    roles: ALL_ROLES,
    description: "Read a note by id, or search the notes of the Quest's own Hall.",
    args: readArchiveArgs,
  },
  {
    name: 'write_archive',
    roles: SENIOR_ROLES,
    description: "Add a note to the Archive, filed under the Quest's own Hall.",
    args: writeArchiveArgs,
  },
  {
    name: 'get_artifact',
    roles: ALL_ROLES,
    description: 'Read an artifact this Quest holds, by hash; returns base64.',
    args: getArtifactArgs,
  },
  {
    name: 'put_artifact',
    roles: ALL_ROLES,
    description: 'Store an artifact for this Quest; returns its hash.',
    args: putArtifactArgs,
  },
  {
    name: 'submit_proposal',
    roles: ALL_ROLES,
    description:
      'File the final draft as a Proposal for the leased Quest; returns its hash and the Verdict. Call it before complete_quest on a Quest that needs a Seal.',
    args: submitProposalArgs,
  },
  {
    name: 'spawn_subquest',
    roles: SENIOR_ROLES,
    description:
      'Spawn a Sub-Quest for another Member to run; returns its id. Bounded by the guild’s spawn caps (spawn_cap, depth_cap). Idempotent only within one attempt: a resumed or retried attempt must call child_results first and not spawn the same work again, or it will hit spawn_cap.',
    args: spawnSubquestArgs,
  },
  {
    name: 'await_children',
    roles: SENIOR_ROLES,
    description:
      'Wait for your Sub-Quests (mode all, or any). If they are not done you give up the worker slot (waiting: true) and the Quest resumes, on a new attempt, when they finish.',
    args: awaitChildrenArgs,
  },
  {
    name: 'child_results',
    roles: SENIOR_ROLES,
    description:
      'Read each Sub-Quest’s status and, once done, its result: an artifact hash and a short summary.',
    args: childResultsArgs,
  },
  {
    name: 'complete_quest',
    roles: ALL_ROLES,
    description: 'Finish the Quest with a schema-checked Handoff. A Handoff is final per attempt.',
    args: completeQuestArgs,
  },
]

/** The ordered tool names `role` gets from `catalog`; an unknown role gets none. */
export function roleToolNames(role: string, catalog: readonly ToolDef[] = TOOL_CATALOG): string[] {
  return catalog.filter((t) => t.roles.includes(role)).map((t) => t.name)
}
