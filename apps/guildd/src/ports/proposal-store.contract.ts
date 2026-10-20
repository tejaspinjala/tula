import { describe, expect, test } from 'bun:test'
import type { Finding } from '../verdict'
import type { NewProposal, ProposalStore } from './proposal-store'
import { hashProposal } from './seal-store'

/** A store under test and a way to get real guilds. */
export interface ProposalStoreFixture {
  store: ProposalStore
  newGuild: () => Promise<string>
}

const PASS: Finding[] = [{ check: 'length', passed: true, detail: 'ok' }]
const FAIL: Finding[] = [{ check: 'length', passed: false, detail: 'too long' }]
const draft = (content: string): NewProposal => ({
  questId: crypto.randomUUID(),
  author: 'herald-1',
  kind: 'post',
  content,
})

/** The ProposalStore contract, run against every adapter. `make` returns a fresh store. */
export function proposalStoreContract(name: string, make: () => Promise<ProposalStoreFixture>) {
  describe(`ProposalStore contract: ${name}`, () => {
    test('a Proposal carries its content hash and the Verdict bound to that hash', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const p = await store.propose(g, draft('Hello world'), { passed: true, findings: PASS })
      const hash = await hashProposal('Hello world')
      expect(p).toMatchObject({ content: 'Hello world', hash })
      expect(p.verdict).toMatchObject({ proposalHash: hash, passed: true, findings: PASS })
      expect(await store.get(g, p.id)).toEqual(p)
      expect(await store.verdictFor(g, hash)).toEqual(p.verdict)
    })

    test('failed Verdicts since an instant list only the failing, recent Proposals of the guild', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const bad = await store.propose(g, draft('Too long'), { passed: false, findings: FAIL })
      await store.propose(g, draft('Fine'), { passed: true, findings: PASS })
      await store.propose(other, draft('Elsewhere'), { passed: false, findings: FAIL })
      const at = bad.createdAt
      const failed = await store.listFailedSince(g, at, { limit: 10 })
      expect(failed.proposals.map((p) => p.id)).toEqual([bad.id])
      expect(failed.next).toBeNull()
      const later = new Date(Date.parse(at) + 1).toISOString()
      expect((await store.listFailedSince(g, later, { limit: 10 })).proposals).toEqual([])
    })

    test('failed Verdicts since an instant are paged', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const a = await store.propose(g, draft('one'), { passed: false, findings: FAIL })
      await store.propose(g, draft('two'), { passed: false, findings: FAIL })
      const first = await store.listFailedSince(g, a.createdAt, { limit: 1 })
      expect(first.proposals).toHaveLength(1)
      expect(first.next).not.toBeNull()
      const second = await store.listFailedSince(g, a.createdAt, {
        limit: 1,
        ...(first.next ? { after: first.next } : {}),
      })
      expect(second.proposals).toHaveLength(1)
      expect(second.next).toBeNull()
    })

    test('the latest Proposal of a Quest is found by its Quest, in its own guild only', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const input = draft('Quest text')
      expect(await store.latestForQuest(g, input.questId)).toBeNull()
      const stored = await store.propose(g, input, { passed: true, findings: PASS })
      expect(await store.latestForQuest(g, input.questId)).toEqual(stored)
      expect(await store.latestForQuest(g, crypto.randomUUID())).toBeNull()
      expect(await store.latestForQuest(other, input.questId)).toBeNull()
    })

    test('the latest Proposal of a Quest is the last one proposed, even at the same clock instant', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const questId = crypto.randomUUID()
      const base = { questId, author: 'herald-1', kind: 'post' }
      for (let round = 0; round < 8; round++) {
        const first = await store.propose(
          g,
          { ...base, content: `First draft ${round}` },
          { passed: true, findings: PASS }
        )
        const second = await store.propose(
          g,
          { ...base, content: `Second draft ${round}` },
          { passed: true, findings: PASS }
        )
        expect(second.createdAt).toBe(first.createdAt)
        expect((await store.latestForQuest(g, questId))?.id).toBe(second.id)
      }
    })

    test('one changed character is a different hash, and the old Verdict does not apply to it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const a = await store.propose(g, draft('Hello world'), { passed: true, findings: PASS })
      const b = await store.propose(g, draft('Hello World'), { passed: false, findings: FAIL })
      expect(b.hash).not.toBe(a.hash)
      expect(b.id).not.toBe(a.id)
      expect((await store.verdictFor(g, a.hash))?.passed).toBe(true)
      expect((await store.verdictFor(g, b.hash))?.passed).toBe(false)
      expect(await store.verdictFor(g, await hashProposal('Hello world!'))).toBeNull()
    })

    test('proposing the same content again returns the same Proposal and keeps its Verdict', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const quest = draft('Same')
      const a = await store.propose(g, quest, { passed: true, findings: PASS })
      const again = await store.propose(g, quest, { passed: false, findings: FAIL })
      expect(again).toEqual(a)
    })

    test("the same content under a second Quest is that Quest's own Proposal, sharing one Verdict", async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const first = draft('Shared')
      const second = draft('Shared')
      const a = await store.propose(g, first, { passed: true, findings: PASS })
      const b = await store.propose(g, second, { passed: false, findings: FAIL })
      expect(b.id).not.toBe(a.id)
      expect(a.questId).toBe(first.questId)
      expect(b.questId).toBe(second.questId)
      expect(b.hash).toBe(a.hash)
      expect(b.verdict).toEqual(a.verdict)
      expect(await store.get(g, b.id)).toEqual(b)
      expect((await store.list(g, { limit: 10 })).proposals.map((p) => p.questId).sort()).toEqual(
        [first.questId, second.questId].sort()
      )
      expect(await store.verdictFor(g, a.hash)).toEqual(a.verdict)
      expect(await store.propose(g, second, { passed: true, findings: PASS })).toEqual(b)
    })

    test('same-tick proposals of the same content create exactly one Proposal', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const racing = draft('Racing')
      const all = await Promise.all(
        Array.from({ length: 5 }, () => store.propose(g, racing, { passed: true, findings: PASS }))
      )
      expect(new Set(all.map((p) => p.id)).size).toBe(1)
      expect((await store.list(g, { limit: 50 })).proposals).toHaveLength(1)
    })

    test('lists are paginated in id order', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (let i = 0; i < 5; i++) {
        await store.propose(g, draft(`post ${i}`), { passed: true, findings: PASS })
      }
      const first = await store.list(g, { limit: 2 })
      expect(first.proposals).toHaveLength(2)
      expect(first.next).not.toBeNull()
      const seen = [...first.proposals]
      let cursor = first.next
      while (cursor) {
        const page = await store.list(g, { limit: 2, after: cursor })
        seen.push(...page.proposals)
        cursor = page.next
      }
      expect(seen.map((p) => p.id)).toEqual(seen.map((p) => p.id).sort())
      expect(new Set(seen.map((p) => p.id)).size).toBe(5)
    })

    test('a guild never sees another guild Proposals or Verdicts', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const p = await store.propose(a, draft('Private to A'), { passed: true, findings: PASS })
      expect(await store.get(b, p.id)).toBeNull()
      expect(await store.verdictFor(b, p.hash)).toBeNull()
      expect((await store.list(b, { limit: 10 })).proposals).toEqual([])
    })
  })
}
