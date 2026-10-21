import type { Handoff } from './ports/handoff-store'

/** The Verdict of the Quest's latest Proposal as a Dossier states it. */
export interface DossierVerdict {
  proposalHash: string
  passed: boolean
  findingCount: number
}

/** The Seal of the Quest's latest round as a Dossier states it. */
export interface DossierSeal {
  status: string
  actionHash: string
}

/** One artifact a Dossier cites, with the size the ObjectStore reports (null when it is missing). */
export interface DossierArtifact {
  hash: string
  size: number | null
}

/** The stored records a Dossier is built from. */
export interface DossierRecords {
  questId: string
  hallId: string
  handoff: Handoff
  /** The hash the HandoffStore holds for `handoff`. */
  handoffHash: string
  verdict: DossierVerdict | null
  seal: DossierSeal | null
}

/**
 * What the ObjectStore showed for each cited artifact hash: the SHA-256 of the bytes it returned
 * and their size, or null when it holds none. Gathered by the caller; the assembler only compares.
 */
export type ArtifactObservations = ReadonlyMap<string, { actualHash: string; size: number } | null>

/** The body of a Dossier: what the subject Quest's records say, with no model in the loop. */
export interface DossierBody {
  questId: string
  hallId: string
  goal: string
  doneCondition: string
  met: boolean
  verdict: DossierVerdict | null
  seal: DossierSeal | null
  handoffHash: string
  artifacts: DossierArtifact[]
}

/** An assembled Dossier. */
export interface AssembledDossier {
  body: DossierBody
  /** SHA-256 (lowercase hex) of the body's canonical JSON. */
  hash: string
  verified: boolean
  /** Machine-readable failed checks, empty when verified. */
  failedChecks: string[]
}

/** Every artifact hash a Handoff cites, as artifact or as artifact evidence, once each in order. */
export function citedArtifacts(_handoff: Handoff): string[] {
  throw new Error('not implemented')
}

/**
 * Builds a Dossier from stored records: pure and deterministic, it never calls a model. It
 * recomputes the Handoff hash and compares each cited artifact with what the ObjectStore showed,
 * and is `verified` only when every check passes.
 */
export function assembleDossier(
  _records: DossierRecords,
  _observed: ArtifactObservations
): AssembledDossier {
  throw new Error('not implemented')
}
