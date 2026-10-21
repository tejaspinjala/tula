import { z } from 'zod'
import type { DossierBody } from '../dossier'

/** Largest page a {@link DossierStore} list returns. */
export const MAX_DOSSIER_PAGE = 100

const hash = z.string().regex(/^[0-9a-f]{64}$/)

/** Zod schema of a stored {@link DossierBody}; what an adapter checks a row against on read. */
export const dossierBodySchema = z.strictObject({
  questId: z.string(),
  hallId: z.string(),
  goal: z.string(),
  doneCondition: z.string(),
  met: z.boolean(),
  verdict: z
    .strictObject({ proposalHash: hash, passed: z.boolean(), findingCount: z.number().int() })
    .nullable(),
  seal: z.strictObject({ status: z.string(), actionHash: hash }).nullable(),
  handoffHash: hash,
  artifacts: z.array(z.strictObject({ hash, size: z.number().int().nullable() })),
})

/** Who asked for a Dossier: a Member's Quest (which is charged the cap) or the Guild Master. */
export type DossierRequester =
  | { kind: 'member'; questId: string; hallId: string; memberId: string }
  | { kind: 'guild_master' }

/** A stored Dossier. Immutable: a repeat request is a new Dossier. */
export interface Dossier {
  id: string
  /** Ordering key: later Dossiers have a larger one; the page cursor. */
  seq: number
  subjectQuestId: string
  subjectHallId: string
  requester: DossierRequester
  body: DossierBody
  /** SHA-256 of the body's canonical JSON. */
  hash: string
  verified: boolean
  failedChecks: string[]
  createdAt: string
}

/** What creating a Dossier stores. */
export interface NewDossier {
  subjectQuestId: string
  subjectHallId: string
  requester: DossierRequester
  body: DossierBody
  hash: string
  verified: boolean
  failedChecks: string[]
  /**
   * The most Dossiers the requesting Quest may have requested (all attempts). Charged only to a
   * Member requester; a Guild Master request has no cap.
   */
  maxPerQuest?: number
  at: Date
}

/** The outcome of creating a Dossier: the stored one, or `dossier_cap`. */
export type CreateDossierResult =
  | { ok: true; dossier: Dossier }
  | { ok: false; error: 'dossier_cap' }

/** What a list selects: Dossiers about, or requested from, one Hall. */
export interface DossierQuery {
  hallId: string
  /** The cursor from the previous page. */
  after?: number
  limit: number
}

/** One page of Dossiers, newest first; `next` is the cursor for the following page, null at the end. */
export interface DossierPage {
  dossiers: Dossier[]
  next: number | null
}

/**
 * Port for Dossiers. Rows are insert-only (never updated), each carrying the dossier hash. The
 * cap check and the insert are one step, so concurrent requests cannot overshoot it, and every
 * create appends its event (ids and hashes only) in the same step.
 */
export interface DossierStore {
  /** Stores a Dossier, or refuses `dossier_cap` when the requesting Quest has used its allowance. */
  create(guildId: string, input: NewDossier): Promise<CreateDossierResult>
  /** One Dossier, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<Dossier | null>
  /** One page of the Dossiers about a Hall's Quests or requested by its Members, newest first. */
  list(guildId: string, query: DossierQuery): Promise<DossierPage>
}
