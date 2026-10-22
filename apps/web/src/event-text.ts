import { z } from 'zod'
import { shortenId } from './GuildId'
import type { ReplayEvent } from './replay'
import { RITE_EVENT } from './rites/events'
import { formatCents } from './treasury'

/** Every event type the web has a sentence for; the exhaustive test walks this list. */
export const EVENT_TYPES = [
  'guild.founded',
  'identity.founding_token_issued',
  'identity.founding_token_spent',
  'identity.passkey_registered',
  'identity.signed_in',
  'identity.signed_out',
  'identity.reauthenticated',
  'identity.enrolment_token_issued',
  'identity.enrolment_token_spent',
  'identity.desktop_code_issued',
  'identity.desktop_code_spent',
  'config.seeded',
  'config.version_proposed',
  'config.version_confirmed',
  'artifact.stored',
  'artifact.attached',
  'handoff.recorded',
  'note.added',
  'note.edited',
  'vault.secret_added',
  'hall.paused',
  'hall.locked',
  'hall.unlocked',
  'hall.resumed',
  'quest.posted',
  'quest.claimed',
  'quest.awaiting_seal',
  'quest.done',
  'quest.retry_scheduled',
  'quest.dead',
  'quest.spawned',
  'missive.sent',
  'proposal.created',
  'verdict.recorded',
  'seal.requested',
  'seal.approved',
  'seal.council_approved',
  'seal.denied',
  'seal.reserved',
  'seal.consumed',
  'seal.released',
  'seal.expired',
  'post.published_manually',
  'treasury.entry',
  'treasury.spend',
  'steward.cap_reached',
  'gates.barred',
  'gates.lifted',
  'guildmaster.away',
  'guildmaster.returned',
  'council.convened',
  'council.voted',
  'council.escalated',
  'council.approved',
  'council.halted',
  'member.activity',
  'campaign.started',
  'campaign.finished',
  'trigger.manual',
  'trigger.schedule',
  'inquiry.asked',
  'inquiry.answered',
  'inquiry.expired',
  'learning.accepted',
  'learning.dismissed',
  'bug_report.filed',
  'bug_report.duplicate',
  'bug_report.fixed',
  'dossier.created',
  'charter.exported',
  'charter.imported',
  'archive.exported',
  'workflow.version_saved',
  'workflow.version_confirmed',
  'workflow.version_published',
  'workflow.run_started',
  'workflow.archived',
  'workflow.unarchived',
] as const

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
export function describeEvent(event: ReplayEvent, names: Record<string, string> = {}): string {
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
    case 'hall.locked':
      return `Hall ${str(p, 'hallId')} locked; its Quests are paused`
    case 'hall.unlocked':
      return `Hall ${str(p, 'hallId')} unlocked; its Quests resume`
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
    case 'seal.council_approved':
      return `Seal ${shortenId(str(p, 'sealId'))} settled by the Council of Elders, not the Guild Master`
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
    case RITE_EVENT.runStarted:
      return 'A Rite run started'
    case RITE_EVENT.versionSaved:
      return 'A Rite version was saved'
    case RITE_EVENT.versionConfirmed:
      return 'A Rite version was confirmed'
    case 'guildmaster.away':
      return 'Guild Master went away'
    case 'guildmaster.returned':
      return 'Guild Master returned'
    case 'council.convened':
      return 'The Council of Elders convened'
    case 'council.voted':
      return 'A voice of the Council of Elders voted'
    case 'council.escalated':
      return 'The Council of Elders sent a Proposal to the Guild Master'
    case 'council.approved':
      return `The Council of Elders approved the Proposal of Quest ${q(p, 'questId', names)} in place of a Seal`
    case 'council.halted':
      return `Bar the Gates halted the Council of Elders; Quest ${q(p, 'questId', names)} stays awaiting a Seal`
    case 'identity.enrolment_token_issued':
      return 'Enrolment token issued'
    case 'identity.enrolment_token_spent':
      return 'Enrolment token spent'
    case 'identity.desktop_code_issued':
      return 'Desktop sign-in code issued'
    case 'identity.desktop_code_spent':
      return 'Desktop sign-in code spent'
    case 'member.activity':
      return `A Member is ${typeof p.activity === 'string' ? p.activity.replaceAll('_', ' ') : 'busy'} on Quest ${q(p, 'questId', names)}`
    case 'campaign.started':
      return 'A Campaign started'
    case 'campaign.finished':
      return 'A Campaign finished'
    case 'trigger.manual':
      return 'A Rite was triggered by hand'
    case 'trigger.schedule':
      return 'A Rite was triggered by its schedule'
    case 'inquiry.asked':
      return 'A Member asked the Guild Master a question'
    case 'inquiry.answered':
      return 'The Guild Master answered a question'
    case 'inquiry.expired':
      return 'A question to the Guild Master expired unanswered'
    case 'learning.accepted':
      return 'A Learning was accepted into the Archive'
    case 'learning.dismissed':
      return 'A Learning was dismissed'
    case 'bug_report.filed':
      return 'A bug report was filed'
    case 'bug_report.duplicate':
      return 'A bug report was matched to an earlier one'
    case 'bug_report.fixed':
      return 'A bug report was marked fixed'
    case 'dossier.created':
      return 'A dossier was created'
    case 'charter.exported':
      return 'The Charter was exported'
    case 'charter.imported':
      return 'A Charter was imported'
    case 'archive.exported':
      return 'The Archive was exported'
    case 'workflow.version_published':
      return 'A Rite version was published'
    case 'workflow.archived':
      return 'A Rite was archived'
    case 'workflow.unarchived':
      return 'A Rite was brought back from the archive'
    default:
      return 'Something happened in the guild'
  }
}
