import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { STREAM_TICKET_TTL_MS, type StreamTicketStore } from './stream-ticket'

/** A store under test with the controllable clock it reads. */
export interface StreamTicketFixture {
  store: StreamTicketStore
  clock: MemoryClock
  newGuild: () => Promise<string>
}

/** The StreamTicketStore contract, run against every adapter. */
export function streamTicketContract(name: string, make: () => Promise<StreamTicketFixture>) {
  describe(`StreamTicketStore contract: ${name}`, () => {
    test('a ticket is single-use, even when spent by many callers in the same tick', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { ticket } = await store.issue(g)
      const spent = await Promise.all(Array.from({ length: 8 }, () => store.consume(g, ticket)))
      expect(spent.filter(Boolean)).toHaveLength(1)
      expect(await store.consume(g, ticket)).toBe(false)
    })

    test('a ticket lapses after its time to live', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const fresh = await store.issue(g)
      clock.advance(STREAM_TICKET_TTL_MS - 1)
      expect(await store.consume(g, fresh.ticket)).toBe(true)
      const stale = await store.issue(g)
      clock.advance(STREAM_TICKET_TTL_MS + 1)
      expect(await store.consume(g, stale.ticket)).toBe(false)
    })

    test('a ticket is bound to the guild it was issued to, and unknown tickets fail', async () => {
      const { store, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const { ticket } = await store.issue(a)
      expect(await store.consume(b, ticket)).toBe(false)
      expect(await store.consume(a, 'not-a-ticket')).toBe(false)
      expect(await store.consume(a, ticket)).toBe(true)
    })
  })
}
