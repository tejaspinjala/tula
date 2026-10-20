import { expect, test } from 'bun:test'
import { eventText } from './event-text'
import type { ReplayEvent } from './replay'

const ev = (type: string, payload: unknown): ReplayEvent => ({
  seq: 7,
  type,
  payload,
  occurredAt: '2026-03-01T08:00:00.000Z',
})

const cases: Array<[ReplayEvent, string]> = [
  [ev('guild.founded', { name: 'Ember', goal: 'Ship' }), 'Guild founded'],
  [ev('identity.founding_token_issued', {}), 'Founding token issued'],
  [ev('identity.founding_token_spent', {}), 'Founding token spent'],
  [ev('identity.passkey_registered', { credentialId: 'c1' }), 'Passkey registered'],
  [ev('identity.signed_in', {}), 'Guild Master signed in'],
  [ev('identity.reauthenticated', {}), 'Guild Master re-authenticated'],
  [ev('config.seeded', { version: 1 }), 'Guild configuration seeded, version 1'],
  [
    ev('config.version_proposed', { version: 3, status: 'pending' }),
    'Configuration version 3 proposed',
  ],
  [ev('config.version_confirmed', { version: 3 }), 'Configuration version 3 confirmed'],
  [ev('artifact.stored', { hash: 'abc123' }), 'Artifact abc123 stored'],
  [
    ev('artifact.attached', { quest_id: 'q1', hash: 'abc123' }),
    'Artifact abc123 attached to Quest q1',
  ],
  [ev('gates.barred', {}), 'The Gates were barred'],
  [ev('gates.lifted', {}), 'The Gates were lifted'],
  [ev('workflow.run_started', {}), 'A workflow run started'],
  [
    ev('seal.approved', { sealId: 'a40f17b7-2938-4be5-a089-1b35ccd2c004' }),
    'Seal a40f17b7…c004 approved',
  ],
  [
    ev('handoff.recorded', { quest_id: 'q1', attempt: 1, handoff_hash: 'abc123' }),
    'Handoff recorded for Quest q1',
  ],
  [ev('note.added', { noteId: 'n1', version: 1, kind: 'lesson' }), 'Note n1 added, version 1'],
  [ev('note.edited', { noteId: 'n1', version: 2, kind: 'lesson' }), 'Note n1 edited, version 2'],
  [ev('vault.secret_added', { ref: 'r1' }), 'Secret added to the Vault'],
  [
    ev('hall.paused', { pauseId: 'p1', hallId: 'h1', tripwire: 'spend' }),
    'Hall h1 paused by tripwire spend',
  ],
  [ev('hall.resumed', { pauseId: 'p1', hallId: 'h1' }), 'Hall h1 resumed'],
  [ev('quest.posted', { questId: 'q1', hallId: 'h1' }), 'Quest q1 posted to Hall h1'],
  [ev('quest.claimed', { questId: 'q1', hallId: 'h1' }), 'Quest q1 claimed in Hall h1'],
  [
    ev('missive.sent', { from: 'ana', to: 'hall', hall: 'h1', excerpt: 'Ready when you are' }),
    'ana sent a Missive to the Hall in Hall h1: Ready when you are',
  ],
  [
    ev('missive.sent', { from: 'ana', to: 'bo', hall: 'h1', excerpt: 'Which tone?' }),
    'ana sent a Missive to bo in Hall h1: Which tone?',
  ],
  [ev('quest.awaiting_seal', { questId: 'q1', hallId: 'h1' }), 'Quest q1 is awaiting a Seal'],
  [ev('quest.done', { questId: 'q1', hallId: 'h1' }), 'Quest q1 done'],
  [ev('quest.retry_scheduled', { questId: 'q1', hallId: 'h1' }), 'Quest q1 scheduled for retry'],
  [ev('quest.dead', { questId: 'q1', hallId: 'h1' }), 'Quest q1 dead-lettered'],
  [
    ev('proposal.created', { proposalId: 'pr1', questId: 'q1' }),
    'Proposal pr1 created for Quest q1',
  ],
  [
    ev('verdict.recorded', { proposalId: 'pr1', passed: true }),
    'Verdict recorded for Proposal pr1: passed',
  ],
  [
    ev('verdict.recorded', { proposalId: 'pr1', passed: false }),
    'Verdict recorded for Proposal pr1: failed',
  ],
  [ev('seal.requested', { sealId: 's1', questId: 'q1' }), 'Seal s1 requested for Quest q1'],
  [ev('seal.approved', { sealId: 's1', questId: 'q1' }), 'Seal s1 approved'],
  [ev('seal.denied', { sealId: 's1', questId: 'q1' }), 'Seal s1 denied'],
  [ev('seal.reserved', { sealId: 's1', questId: 'q1' }), 'Seal s1 reserved'],
  [ev('seal.consumed', { sealId: 's1', questId: 'q1' }), 'Seal s1 consumed'],
  [ev('seal.released', { sealId: 's1', questId: 'q1' }), 'Seal s1 released'],
  [ev('seal.expired', { sealId: 's1', questId: 'q1' }), 'Seal s1 expired'],
  [
    ev('post.published_manually', { sealId: 's1', questId: 'q1' }),
    'Post for Seal s1 published by hand',
  ],
  [
    ev('treasury.entry', {
      entryId: 'e1',
      kind: 'revenue',
      bucket: 'operating',
      amountCents: 1250,
    }),
    'Treasury entry: revenue of $12.50 in operating',
  ],
  [
    ev('treasury.entry', {
      entryId: 'e2',
      kind: 'spend_reserve',
      bucket: 'operating',
      amountCents: -300,
    }),
    'Treasury entry: spend_reserve of -$3.00 in operating',
  ],
  [
    ev('treasury.spend', { spendId: 'sp1', status: 'reserved', amountCents: 500 }),
    'Treasury spend sp1 reserved, $5.00',
  ],
  [
    ev('steward.cap_reached', { day: '2026-03-01', reason: 'daily' }),
    'Steward reported the daily cap reached on 2026-03-01',
  ],
]

test.each(cases)('event %#: text names the event in plain words', (event, text) => {
  expect(eventText(event)).toBe(text)
})

test('an unknown event still has text, and a malformed payload never throws', () => {
  expect(eventText(ev('future.thing', { x: 1 }))).toBe('Event future.thing, number 7')
  expect(eventText(ev('quest.done', 5))).toBe('Quest done')
})

test('text never carries secret-looking payload fields', () => {
  const text = eventText(
    ev('vault.secret_added', { ref: 'r1', value: 'sk-live-123', token: 'tok', hash: 'h' })
  )
  expect(text).not.toContain('sk-live-123')
  expect(text).not.toContain('tok')
})
