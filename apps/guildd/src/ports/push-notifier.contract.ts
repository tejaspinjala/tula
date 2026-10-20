import { describe, expect, test } from 'bun:test'
import type { PushNotifier, PushPayload } from './push-notifier'

/** A notifier under test, with a view of what reached the (fake) push service. */
export interface PushNotifierFixture {
  notifier: PushNotifier
  /** Makes the push service answer 404/410 for this endpoint from now on. */
  markGone: (endpoint: string) => void
  /** Payloads the push service accepted for `endpoint`, in order. */
  delivered: (endpoint: string) => Promise<PushPayload[]>
}

const target = (endpoint: string) => ({ endpoint, p256dh: 'unused', auth: 'unused' })

/** The PushNotifier contract, run against every adapter. */
export function pushNotifierContract(name: string, make: () => Promise<PushNotifierFixture>) {
  describe(`PushNotifier contract: ${name}`, () => {
    test('a send reaches the endpoint with ids only', async () => {
      const { notifier, delivered } = await make()
      const payload = { sealId: crypto.randomUUID(), guildId: crypto.randomUUID() }
      expect(await notifier.send(target('https://push.example/a'), payload)).toBe('sent')
      expect(await delivered('https://push.example/a')).toEqual([payload])
      expect(await delivered('https://push.example/b')).toEqual([])
    })

    test('an endpoint the push service has dropped answers gone and receives nothing', async () => {
      const { notifier, markGone, delivered } = await make()
      markGone('https://push.example/old')
      const payload = { sealId: crypto.randomUUID(), guildId: crypto.randomUUID() }
      expect(await notifier.send(target('https://push.example/old'), payload)).toBe('gone')
      expect(await delivered('https://push.example/old')).toEqual([])
    })
  })
}
