import { z } from 'zod'
import type { ReplayEvent } from './replay'
import { formatCents } from './treasury'

const fields = z.record(z.string(), z.unknown())

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '?'
}

function cents(p: Record<string, unknown>): string {
  const v = p.amountCents
  return typeof v === 'number' ? formatCents(v) : '?'
}

/**
 * Plain-language, screen-reader text for one event. It names ids, hashes and amounts only; it
 * never reads secret-bearing fields, and an unknown or malformed event still gets text.
 */
export function eventText(event: ReplayEvent): string {
  const parsed = fields.safeParse(event.payload)
  const p: Record<string, unknown> = parsed.success ? parsed.data : {}
  const has = parsed.success
  switch (event.type) {
    case 'guild.founded':
      return 'Guild founded'
    case 'identity.founding_token_issued':
      return 'Founding token issued'
    case 'identity.founding_token_spent':
      return 'Founding token spent'
    case 'identity.passkey_registered':
      return 'Passkey registered'
    case 'identity.signed_in':
      return 'Guild Master signed in'
    case 'identity.reauthenticated':
      return 'Guild Master re-authenticated'
    case 'config.seeded':
      return `Guild configuration seeded, version ${str(p, 'version')}`
    case 'config.version_proposed':
      return `Configuration version ${str(p, 'version')} proposed`
    case 'config.version_confirmed':
      return `Configuration version ${str(p, 'version')} confirmed`
    case 'artifact.stored':
      return `Artifact ${str(p, 'hash')} stored`
    case 'artifact.attached':
      return `Artifact ${str(p, 'hash')} attached to Quest ${str(p, 'quest_id')}`
    case 'handoff.recorded':
      return `Handoff recorded for Quest ${str(p, 'questId')}`
    case 'note.added':
      return `Note ${str(p, 'noteId')} added, version ${str(p, 'version')}`
    case 'note.edited':
      return `Note ${str(p, 'noteId')} edited, version ${str(p, 'version')}`
    case 'vault.secret_added':
      return 'Secret added to the Vault'
    case 'hall.paused':
      return `Hall ${str(p, 'hallId')} paused by tripwire ${str(p, 'tripwire')}`
    case 'hall.resumed':
      return `Hall ${str(p, 'hallId')} resumed`
    case 'quest.posted':
      return has ? `Quest ${str(p, 'questId')} posted to Hall ${str(p, 'hallId')}` : 'Quest posted'
    case 'quest.claimed':
      return has
        ? `Quest ${str(p, 'questId')} claimed in Hall ${str(p, 'hallId')}`
        : 'Quest claimed'
    case 'quest.awaiting_seal':
      return has ? `Quest ${str(p, 'questId')} is awaiting a Seal` : 'Quest awaiting a Seal'
    case 'quest.done':
      return has ? `Quest ${str(p, 'questId')} done` : 'Quest done'
    case 'quest.retry_scheduled':
      return has ? `Quest ${str(p, 'questId')} scheduled for retry` : 'Quest scheduled for retry'
    case 'quest.dead':
      return has ? `Quest ${str(p, 'questId')} dead-lettered` : 'Quest dead-lettered'
    case 'proposal.created':
      return `Proposal ${str(p, 'proposalId')} created for Quest ${str(p, 'questId')}`
    case 'verdict.recorded':
      return `Verdict recorded for Proposal ${str(p, 'proposalId')}: ${p.passed === true ? 'passed' : 'failed'}`
    case 'seal.requested':
      return `Seal ${str(p, 'sealId')} requested for Quest ${str(p, 'questId')}`
    case 'seal.approved':
      return `Seal ${str(p, 'sealId')} approved`
    case 'seal.denied':
      return `Seal ${str(p, 'sealId')} denied`
    case 'seal.reserved':
      return `Seal ${str(p, 'sealId')} reserved`
    case 'seal.consumed':
      return `Seal ${str(p, 'sealId')} consumed`
    case 'seal.released':
      return `Seal ${str(p, 'sealId')} released`
    case 'seal.expired':
      return `Seal ${str(p, 'sealId')} expired`
    case 'post.published_manually':
      return `Post for Seal ${str(p, 'sealId')} published by hand`
    case 'treasury.entry':
      return `Treasury entry: ${str(p, 'kind')} of ${cents(p)} in ${str(p, 'bucket')}`
    case 'treasury.spend':
      return `Treasury spend ${str(p, 'spendId')} ${str(p, 'status')}, ${cents(p)}`
    case 'steward.cap_reached':
      return `Steward reported the ${str(p, 'reason')} cap reached on ${str(p, 'day')}`
    default:
      return `Event ${event.type}, number ${event.seq}`
  }
}
