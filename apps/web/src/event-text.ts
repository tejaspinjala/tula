import { z } from 'zod'
import { shortenId } from './GuildId'
import type { ReplayEvent } from './replay'
import { formatCents } from './treasury'

const fields = z.record(z.string(), z.unknown())

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '?'
}

/** A Quest's title when the caller knows it, else its (shortened) id. */
function q(p: Record<string, unknown>, key: string, names: Record<string, string>): string {
  const id = str(p, key)
  return names[id] ?? (id === '?' ? id : shortenId(id))
}

function cents(p: Record<string, unknown>): string {
  const v = p.amountCents
  return typeof v === 'number' ? formatCents(v) : '?'
}

/**
 * Plain-language, screen-reader text for one event; `names` maps Quest ids to titles. It names ids, hashes and amounts only; it
 * never reads secret-bearing fields, and an unknown or malformed event still gets text.
 */
export function eventText(event: ReplayEvent, names: Record<string, string> = {}): string {
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
    case 'identity.signed_out':
      return 'Guild Master signed out'
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
      return `Artifact ${str(p, 'hash')} attached to Quest ${q(p, 'quest_id', names)}`
    case 'handoff.recorded':
      return `Handoff recorded for Quest ${q(p, 'quest_id', names)}`
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
      return has
        ? `Quest ${q(p, 'questId', names)} posted to Hall ${str(p, 'hallId')}`
        : 'Quest posted'
    case 'quest.claimed':
      return has
        ? `Quest ${q(p, 'questId', names)} claimed in Hall ${str(p, 'hallId')}`
        : 'Quest claimed'
    case 'missive.sent':
      return `${str(p, 'from')} sent a Missive to ${str(p, 'to') === 'hall' ? 'the Hall' : str(p, 'to')} in Hall ${str(p, 'hall')}`
    case 'quest.awaiting_seal':
      return has ? `Quest ${q(p, 'questId', names)} is awaiting a Seal` : 'Quest awaiting a Seal'
    case 'quest.done':
      return has ? `Quest ${q(p, 'questId', names)} done` : 'Quest done'
    case 'quest.retry_scheduled':
      return has
        ? `Quest ${q(p, 'questId', names)} scheduled for retry`
        : 'Quest scheduled for retry'
    case 'quest.dead':
      return has ? `Quest ${q(p, 'questId', names)} dead-lettered` : 'Quest dead-lettered'
    case 'proposal.created':
      return `Proposal ${str(p, 'proposalId')} created for Quest ${q(p, 'questId', names)}`
    case 'verdict.recorded':
      return `Verdict recorded for Proposal ${str(p, 'proposalId')}: ${p.passed === true ? 'passed' : 'failed'}`
    case 'seal.requested':
      return `Seal ${shortenId(str(p, 'sealId'))} requested for Quest ${q(p, 'questId', names)}`
    case 'seal.approved':
      return `Seal ${shortenId(str(p, 'sealId'))} approved`
    case 'seal.denied':
      return `Seal ${shortenId(str(p, 'sealId'))} denied`
    case 'seal.reserved':
      return `Seal ${shortenId(str(p, 'sealId'))} reserved`
    case 'seal.consumed':
      return `Seal ${shortenId(str(p, 'sealId'))} consumed`
    case 'seal.released':
      return `Seal ${shortenId(str(p, 'sealId'))} released`
    case 'seal.expired':
      return `Seal ${shortenId(str(p, 'sealId'))} expired`
    case 'post.published_manually':
      return `Post for Seal ${shortenId(str(p, 'sealId'))} published by hand`
    case 'treasury.entry':
      return `Treasury entry: ${str(p, 'kind')} of ${cents(p)} in ${str(p, 'bucket')}`
    case 'treasury.spend':
      return `Treasury spend ${str(p, 'spendId')} ${str(p, 'status')}, ${cents(p)}`
    case 'steward.cap_reached':
      return `Steward reported the ${str(p, 'reason')} cap reached on ${str(p, 'day')}`
    case 'gates.barred':
      return 'The Gates were barred'
    case 'gates.lifted':
      return 'The Gates were lifted'
    case 'quest.spawned':
      return 'A Sub-Quest was spawned'
    case 'workflow.run_started':
      return 'A workflow run started'
    case 'workflow.version_saved':
      return 'A workflow version was saved'
    case 'workflow.version_confirmed':
      return 'A workflow version was confirmed'
    case 'guildmaster.away':
      return 'Guild Master went away'
    case 'guildmaster.returned':
      return 'Guild Master returned'
    default:
      return `Event ${event.type}, number ${event.seq}`
  }
}
