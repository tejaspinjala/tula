import { describe, expect, test } from 'bun:test'
import type { InquiryStore, NewInquiry } from './inquiry-store'
import type { QuestQueue } from './quest-queue'

/** A store under test, with the Quest queue it posts answer Quests onto. */
export interface InquiryStoreFixture {
  store: InquiryStore
  quests: QuestQueue
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const DAY = 86_400_000

let counter = 0
function asked(over: Partial<NewInquiry> = {}): NewInquiry {
  counter += 1
  const id = crypto.randomUUID()
  return {
    id,
    fromHall: 'heralds',
    toHall: 'scribes',
    askQuestId: crypto.randomUUID(),
    attempt: 1,
    asker: 'heralds-member-2',
    question: `Which tone, take ${counter}?`,
    maxPerQuest: 3,
    at: T0,
    expiresAt: new Date(T0.getTime() + 7 * DAY),
    answerQuest: {
      jobKey: `inquiry:${id}`,
      templateId: 'inquiry-answer',
      hallId: 'scribes',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Answer an Inquiry',
      ownerId: 'scribes-captain',
      doneCondition: `Answer Inquiry ${id}`,
      roundLimit: 2,
      board: false,
    },
    ...over,
  }
}

/** The InquiryStore contract, run against every adapter. `make` returns a fresh store. */
export function inquiryStoreContract(name: string, make: () => Promise<InquiryStoreFixture>) {
  describe(`InquiryStore contract: ${name}`, () => {
    test('an ask stores an open Inquiry and posts its answer Quest on the target Hall', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const input = asked()
      const out = await store.ask(g, input)
      expect(out.ok).toBe(true)
      if (!out.ok) {
        return
      }
      expect(out.created).toBe(true)
      expect(out.inquiry).toMatchObject({
        id: input.id,
        fromHall: 'heralds',
        toHall: 'scribes',
        askQuestId: input.askQuestId,
        answerQuestId: out.answerQuest.id,
        asker: 'heralds-member-2',
        question: input.question,
        status: 'open',
        answer: null,
        answeredBy: null,
        noteId: null,
      })
      expect(out.answerQuest).toMatchObject({ hallId: 'scribes', templateId: 'inquiry-answer' })
      expect((await quests.get(g, out.answerQuest.id))?.id).toBe(out.answerQuest.id)
      expect((await store.get(g, input.id))?.status).toBe('open')
    })

    test('the same ask again in one attempt returns the first Inquiry and posts nothing new', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const first = asked()
      const a = await store.ask(g, first)
      const b = await store.ask(g, {
        ...first,
        id: crypto.randomUUID(),
        answerQuest: { ...first.answerQuest, jobKey: `inquiry:${crypto.randomUUID()}` },
      })
      expect(a.ok && b.ok && a.inquiry.id === b.inquiry.id && !b.created).toBe(true)
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(1)
    })

    test('past the per-Quest cap an ask is refused and posts no Quest', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const askQuestId = crypto.randomUUID()
      expect((await store.ask(g, asked({ askQuestId, maxPerQuest: 1 }))).ok).toBe(true)
      expect(await store.ask(g, asked({ askQuestId, maxPerQuest: 1 }))).toEqual({
        ok: false,
        error: 'inquiry_cap',
      })
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(1)
    })

    test('concurrent asks cannot pass the cap', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const askQuestId = crypto.randomUUID()
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => store.ask(g, asked({ askQuestId, maxPerQuest: 2 })))
      )
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(2)
    })

    test('an answer is recorded once; a second answer is refused', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      const give = (answer: string) =>
        store.answer(g, {
          inquiryId: out.inquiry.id,
          answerQuestId: out.answerQuest.id,
          by: 'scribes-captain',
          answer,
          at: new Date(T0.getTime() + DAY),
        })
      const first = await give('Formal.')
      expect(first.ok && first.inquiry).toMatchObject({
        status: 'answered',
        answer: 'Formal.',
        answeredBy: 'scribes-captain',
      })
      expect(await give('Casual.')).toEqual({ ok: false, error: 'inquiry_answered' })
      expect((await store.get(g, out.inquiry.id))?.answer).toBe('Formal.')
    })

    test('concurrent answers record exactly one', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      const results = await Promise.all(
        ['a', 'b', 'c'].map((answer) =>
          store.answer(g, {
            inquiryId: out.inquiry.id,
            answerQuestId: out.answerQuest.id,
            by: 'scribes-captain',
            answer,
            at: T0,
          })
        )
      )
      expect(results.filter((r) => r.ok)).toHaveLength(1)
    })

    test('only the Inquiry’s own answer Quest may answer it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      expect(
        await store.answer(g, {
          inquiryId: out.inquiry.id,
          answerQuestId: crypto.randomUUID(),
          by: 'x',
          answer: 'nope',
          at: T0,
        })
      ).toEqual({ ok: false, error: 'not_found' })
      expect((await store.get(g, out.inquiry.id))?.status).toBe('open')
    })

    test('an overdue Inquiry cannot be answered, and the sweep expires it once', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      const late = new Date(T0.getTime() + 8 * DAY)
      expect(await store.expireOverdue(g, new Date(T0.getTime() + DAY))).toBe(0)
      expect(await store.expireOverdue(g, late)).toBe(1)
      expect(await store.expireOverdue(g, late)).toBe(0)
      expect((await store.get(g, out.inquiry.id))?.status).toBe('expired')
      expect(
        await store.answer(g, {
          inquiryId: out.inquiry.id,
          answerQuestId: out.answerQuest.id,
          by: 'scribes-captain',
          answer: 'too late',
          at: late,
        })
      ).toEqual({ ok: false, error: 'inquiry_expired' })
    })

    test('a sweep expires at most 200 overdue Inquiries; the next takes the rest, none twice', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (let i = 0; i < 205; i++) {
        expect((await store.ask(g, asked())).ok).toBe(true)
      }
      const late = new Date(T0.getTime() + 8 * DAY)
      expect(await store.expireOverdue(g, late)).toBe(200)
      expect(await store.expireOverdue(g, late)).toBe(5)
      expect(await store.expireOverdue(g, late)).toBe(0)
    })

    test('an unswept overdue Inquiry is refused as expired too', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      expect(
        await store.answer(g, {
          inquiryId: out.inquiry.id,
          answerQuestId: out.answerQuest.id,
          by: 'scribes-captain',
          answer: 'late',
          at: new Date(T0.getTime() + 9 * DAY),
        })
      ).toEqual({ ok: false, error: 'inquiry_expired' })
    })

    test('an answered Inquiry is never expired by the sweep', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      await store.answer(g, {
        inquiryId: out.inquiry.id,
        answerQuestId: out.answerQuest.id,
        by: 'scribes-captain',
        answer: 'ok',
        at: T0,
      })
      expect(await store.expireOverdue(g, new Date(T0.getTime() + 30 * DAY))).toBe(0)
      expect((await store.get(g, out.inquiry.id))?.status).toBe('answered')
    })

    test('the filed note id is kept', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const out = await store.ask(g, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      const noteId = crypto.randomUUID()
      await store.attachNote(g, out.inquiry.id, noteId)
      expect((await store.get(g, out.inquiry.id))?.noteId).toBe(noteId)
    })

    test('a Hall lists the Inquiries it asked and was asked, newest first, in pages', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const [question, from, to] of [
        ['q1', 'heralds', 'scribes'],
        ['q2', 'scribes', 'heralds'],
        ['q3', 'heralds', 'scribes'],
        ['q4', 'forge', 'scribes'],
      ] as const) {
        const input = asked({ question, fromHall: from, toHall: to })
        await store.ask(g, {
          ...input,
          answerQuest: { ...input.answerQuest, hallId: to },
        })
      }
      const first = await store.list(g, { hallId: 'heralds', limit: 2 })
      expect(first.inquiries.map((i) => i.question)).toEqual(['q3', 'q2'])
      expect(first.next).not.toBeNull()
      const second = await store.list(g, {
        hallId: 'heralds',
        limit: 2,
        ...(first.next === null ? {} : { after: first.next }),
      })
      expect(second.inquiries.map((i) => i.question)).toEqual(['q1'])
      expect(second.next).toBeNull()
    })

    test('another guild sees nothing of an Inquiry', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const out = await store.ask(a, asked())
      if (!out.ok) {
        throw new Error('ask refused')
      }
      expect(await store.get(b, out.inquiry.id)).toBeNull()
      expect((await store.list(b, { hallId: 'scribes', limit: 10 })).inquiries).toEqual([])
      expect(await store.expireOverdue(b, new Date(T0.getTime() + 30 * DAY))).toBe(0)
      expect((await store.get(a, out.inquiry.id))?.status).toBe('open')
    })

    describe('read marker', () => {
      async function askThree(store: InquiryStore, g: string): Promise<number[]> {
        const seqs: number[] = []
        for (let n = 0; n < 3; n += 1) {
          const out = await store.ask(g, asked())
          if (!out.ok) {
            throw new Error('ask refused')
          }
          seqs.push(out.inquiry.seq)
        }
        return seqs
      }

      test('every open Inquiry is unread until the Mailbox is marked', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        await askThree(store, g)
        expect(await store.unreadCounts(g, ['scribes', 'heralds', 'smiths'])).toEqual({
          scribes: 3,
          heralds: 3,
          smiths: 0,
        })
      })

      test('the total counts an Inquiry between two Halls once, not once per Hall', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        await askThree(store, g)
        expect(await store.unreadTotal(g, ['scribes', 'heralds', 'smiths'])).toBe(3)
        expect(await store.unreadTotal(g, ['smiths'])).toBe(0)
        expect(await store.unreadTotal(g, [])).toBe(0)
      })

      test('the total drops an Inquiry only once every Hall asked about has read it', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [, , third] = await askThree(store, g)
        await store.markRead(g, 'scribes', third ?? 0)
        expect(await store.unreadTotal(g, ['scribes', 'heralds'])).toBe(3)
        await store.markRead(g, 'heralds', third ?? 0)
        expect(await store.unreadTotal(g, ['scribes', 'heralds'])).toBe(0)
      })

      test('another guild adds nothing to the total', async () => {
        const { store, newGuild } = await make()
        const a = await newGuild()
        const b = await newGuild()
        await askThree(store, a)
        expect(await store.unreadTotal(b, ['scribes', 'heralds'])).toBe(0)
      })

      test('marking counts only the Inquiries newer than the marker', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [first, second] = await askThree(store, g)
        expect(await store.markRead(g, 'scribes', second ?? 0)).toBe(second ?? 0)
        expect(await store.unreadCounts(g, ['scribes', 'heralds'])).toEqual({
          scribes: 1,
          heralds: 3,
        })
        expect(first).toBeLessThan(second ?? 0)
      })

      test('answered and expired Inquiries are not unread', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const out = await store.ask(g, asked())
        if (!out.ok) {
          throw new Error('ask refused')
        }
        await store.answer(g, {
          inquiryId: out.inquiry.id,
          answerQuestId: out.inquiry.answerQuestId,
          by: 'scribes-captain',
          answer: 'Warm.',
          at: new Date(T0.getTime() + 1000),
        })
        await store.ask(g, asked())
        await store.expireOverdue(g, new Date(T0.getTime() + 30 * DAY))
        expect((await store.unreadCounts(g, ['scribes'])).scribes).toBe(0)
      })

      test('replaying an older marker never moves it backwards', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [first, , third] = await askThree(store, g)
        expect(await store.markRead(g, 'scribes', third ?? 0)).toBe(third ?? 0)
        expect(await store.markRead(g, 'scribes', first ?? 0)).toBe(third ?? 0)
        expect(await store.markRead(g, 'scribes', third ?? 0)).toBe(third ?? 0)
        expect((await store.unreadCounts(g, ['scribes'])).scribes).toBe(0)
      })

      test('a marker never passes the Hall newest Inquiry, so later mail stays unread', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [, , third] = await askThree(store, g)
        expect(await store.markRead(g, 'scribes', 1_000_000_000)).toBe(third ?? 0)
        await store.ask(g, asked())
        expect((await store.unreadCounts(g, ['scribes'])).scribes).toBe(1)
        expect(await store.markRead(g, 'smiths', 5)).toBe(0)
      })

      test('a marker is kept per Hall', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [, , third] = await askThree(store, g)
        await store.markRead(g, 'scribes', third ?? 0)
        expect(await store.unreadCounts(g, ['scribes', 'heralds'])).toEqual({
          scribes: 0,
          heralds: 3,
        })
      })

      test('concurrent markers settle on the newest', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const [first, second, third] = await askThree(store, g)
        await Promise.all([
          store.markRead(g, 'scribes', second ?? 0),
          store.markRead(g, 'scribes', third ?? 0),
          store.markRead(g, 'scribes', first ?? 0),
        ])
        expect((await store.unreadCounts(g, ['scribes'])).scribes).toBe(0)
      })

      test('another guild neither sees nor moves a marker', async () => {
        const { store, newGuild } = await make()
        const a = await newGuild()
        const b = await newGuild()
        const [, , third] = await askThree(store, a)
        await askThree(store, b)
        await store.markRead(a, 'scribes', third ?? 0)
        expect((await store.unreadCounts(a, ['scribes'])).scribes).toBe(0)
        expect((await store.unreadCounts(b, ['scribes'])).scribes).toBe(3)
        expect(await store.markRead(b, 'scribes', 0)).toBe(0)
      })
    })
  })
}
