import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { proposalStoreContract } from '../ports/proposal-store.contract'
import { hashProposal } from '../ports/seal-store'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgProposalStore } from './pg-proposal-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
const newGuild = () => foundTestGuild(db, { name: 'Proposals', goal: 'g' })

proposalStoreContract('postgres', async () => ({
  store: new PgProposalStore(db, new MemoryKeyProvider(), clock),
  newGuild,
}))

const refused = (sql: string) =>
  owner.unsafe(sql).then(
    () => 'ok',
    (e: Error) => e.message
  )

test('events carry ids and hashes only, never the content', async () => {
  const guild = await newGuild()
  const store = new PgProposalStore(db, new MemoryKeyProvider(), clock)
  await store.propose(
    guild,
    {
      questId: crypto.randomUUID(),
      author: 'herald-1',
      kind: 'post',
      content: 'secret-draft-text',
    },
    { passed: true, findings: [{ check: 'length', passed: true, detail: 'ok' }] }
  )
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type ~ '^(proposal|verdict)\\.' order by seq`
  expect(events.map((e) => e.type)).toEqual(['proposal.created', 'verdict.recorded'])
  const json = JSON.stringify(events)
  expect(json).toContain(await hashProposal('secret-draft-text'))
  expect(json).not.toContain('secret-draft-text')
})

test('the database binds the hash to the content and freezes Proposals and Verdicts', async () => {
  const guild = await newGuild()
  const store = new PgProposalStore(db, new MemoryKeyProvider(), clock)
  const p = await store.propose(
    guild,
    { questId: crypto.randomUUID(), author: 'a', kind: 'post', content: 'frozen' },
    { passed: false, findings: [{ check: 'length', passed: false, detail: 'no' }] }
  )
  expect(
    await refused(
      `insert into proposals (guild_id, quest_id, author, kind, content, content_hash, created_at)
       values ('${guild}', gen_random_uuid(), 'a', 'post', 'real', '${'b'.repeat(64)}', now())`
    )
  ).toContain('proposals_hash_binds_content')
  expect(await refused(`update verdicts set passed = true where guild_id = '${guild}'`)).toContain(
    'immutable'
  )
  expect(await refused(`delete from verdicts where guild_id = '${guild}'`)).toContain('immutable')
  expect(
    await refused(`update proposals set content = 'edited' where guild_id = '${guild}'`)
  ).toContain('immutable')
  expect((await store.verdictFor(guild, p.hash))?.passed).toBe(false)
})

test('the same content under two Quests emits proposal.created per Quest and one verdict.recorded', async () => {
  const guild = await newGuild()
  const store = new PgProposalStore(db, new MemoryKeyProvider(), clock)
  const verdict = {
    passed: true,
    findings: [{ check: 'length' as const, passed: true, detail: 'ok' }],
  }
  const draft = () => ({
    questId: crypto.randomUUID(),
    author: 'herald-1',
    kind: 'post',
    content: 'shared-text',
  })
  await store.propose(guild, draft(), verdict)
  await store.propose(guild, draft(), verdict)
  const events = await owner`
    select type from events where guild_id = ${guild} and type ~ '^(proposal|verdict)\\.' order by seq`
  expect(events.map((e) => e.type)).toEqual([
    'proposal.created',
    'verdict.recorded',
    'proposal.created',
  ])
})

test('a Verdict needs a Proposal of the same content, and a Proposal needs a Verdict by commit', async () => {
  const guild = await newGuild()
  expect(
    await refused(
      `insert into verdicts (guild_id, proposal_hash, passed, findings, checked_at)
       values ('${guild}', '${'c'.repeat(64)}', true, '[]'::jsonb, now())`
    )
  ).toContain('verdict_needs_proposal')
  expect(
    await refused(
      `insert into proposals (guild_id, quest_id, author, kind, content, content_hash, created_at)
       values ('${guild}', gen_random_uuid(), 'a', 'post', 'orphan', '${await hashProposal('orphan')}', now())`
    )
  ).toContain('proposal_needs_verdict')
})
