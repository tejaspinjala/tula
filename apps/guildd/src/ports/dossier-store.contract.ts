import { describe, expect, test } from 'bun:test'
import type { DossierBody } from '../dossier'
import type { DossierStore, NewDossier } from './dossier-store'

/** A store under test; a database-backed store needs real guilds. */
export interface DossierStoreFixture {
  store: DossierStore
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const H = 'a'.repeat(64)

function body(over: Partial<DossierBody> = {}): DossierBody {
  return {
    questId: crypto.randomUUID(),
    hallId: 'heralds',
    goal: 'Ship it',
    doneCondition: 'It ships',
    met: true,
    verdict: { proposalHash: H, passed: true, findingCount: 0 },
    seal: { status: 'consumed', actionHash: H },
    handoffHash: H,
    artifacts: [{ hash: H, size: 12 }],
    ...over,
  }
}

function made(over: Partial<NewDossier> = {}): NewDossier {
  const b = body()
  return {
    subjectQuestId: b.questId,
    subjectHallId: 'heralds',
    requester: { kind: 'member', questId: crypto.randomUUID(), hallId: 'forge', memberId: 'm-ada' },
    body: b,
    hash: H,
    verified: true,
    failedChecks: [],
    maxPerQuest: 5,
    at: T0,
    ...over,
  }
}

/** The DossierStore contract, run against every adapter. `make` returns a fresh store. */
export function dossierStoreContract(name: string, make: () => Promise<DossierStoreFixture>) {
  describe(`DossierStore contract: ${name}`, () => {
    test('a created Dossier reads back whole, with its hash and failed checks', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = made({ verified: false, failedChecks: [`artifact_missing:${H}`] })
      const created = await store.create(g, input)
      expect(created.ok).toBe(true)
      const id = created.ok ? created.dossier.id : ''
      const got = await store.get(g, id)
      expect(got).toMatchObject({
        id,
        subjectQuestId: input.subjectQuestId,
        subjectHallId: 'heralds',
        requester: input.requester,
        body: input.body,
        hash: H,
        verified: false,
        failedChecks: [`artifact_missing:${H}`],
        createdAt: T0.toISOString(),
      })
    })

    test('an unknown id reads as null', async () => {
      const { store, newGuild } = await make()
      expect(await store.get(await newGuild(), crypto.randomUUID())).toBeNull()
    })

    test('a repeat request for the same subject is a fresh Dossier', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = made()
      const one = await store.create(g, input)
      const two = await store.create(g, input)
      expect(one.ok && two.ok && one.dossier.id !== two.dossier.id).toBe(true)
    })

    test('the requesting Quest is held to its cap, others are not, and the Guild Master has none', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const requester = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm-ada',
      }
      expect((await store.create(g, made({ requester, maxPerQuest: 2 }))).ok).toBe(true)
      expect((await store.create(g, made({ requester, maxPerQuest: 2 }))).ok).toBe(true)
      expect(await store.create(g, made({ requester, maxPerQuest: 2 }))).toEqual({
        ok: false,
        error: 'dossier_cap',
      })
      expect((await store.create(g, made({ maxPerQuest: 2 }))).ok).toBe(true)
      for (let i = 0; i < 4; i++) {
        const { maxPerQuest: _unused, ...free } = made({ requester: { kind: 'guild_master' } })
        expect((await store.create(g, free)).ok).toBe(true)
      }
    })

    test('countForQuest counts the Dossiers a Quest requested, in its own guild only', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const requester = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm-ada',
      }
      expect(await store.countForQuest(g, requester.questId)).toBe(0)
      await store.create(g, made({ requester }))
      await store.create(g, made({ requester }))
      await store.create(g, made())
      expect(await store.countForQuest(g, requester.questId)).toBe(2)
      expect(await store.countForQuest(await newGuild(), requester.questId)).toBe(0)
    })

    test('a cap of zero refuses the first request', async () => {
      const { store, newGuild } = await make()
      expect(await store.create(await newGuild(), made({ maxPerQuest: 0 }))).toEqual({
        ok: false,
        error: 'dossier_cap',
      })
    })

    test('same-tick requests cannot overshoot the cap', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const requester = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm-ada',
      }
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => store.create(g, made({ requester, maxPerQuest: 2 })))
      )
      expect(results.filter((r) => r.ok)).toHaveLength(2)
    })

    test('a Hall lists Dossiers about its Quests and requested by it, newest first, in pages', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const about = await store.create(g, made({ subjectHallId: 'heralds' }))
      const by = await store.create(
        g,
        made({
          subjectHallId: 'scribes',
          requester: {
            kind: 'member',
            questId: crypto.randomUUID(),
            hallId: 'heralds',
            memberId: 'm',
          },
        })
      )
      await store.create(g, made({ subjectHallId: 'scribes' }))
      const first = await store.list(g, { hallId: 'heralds', limit: 1 })
      expect(first.dossiers.map((d) => d.id)).toEqual([by.ok ? by.dossier.id : ''])
      expect(first.next).not.toBeNull()
      const second = await store.list(g, {
        hallId: 'heralds',
        limit: 1,
        ...(first.next === null ? {} : { after: first.next }),
      })
      expect(second.dossiers.map((d) => d.id)).toEqual([about.ok ? about.dossier.id : ''])
      expect(second.next).toBeNull()
    })
  })
}
