import { z } from 'zod'
import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** The slice of the browser's push manager the ledger uses. */
export interface PushManagerLike {
  subscribe(options: {
    userVisibleOnly: boolean
    applicationServerKey: Uint8Array<ArrayBuffer>
  }): Promise<{ toJSON(): unknown }>
}

const keyBody = z.object({ publicKey: z.string().min(1) })
const subscriptionJson = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

/**
 * Asks the Guild Master for notification permission, subscribes this device with the server's
 * VAPID key and registers the subscription. `unavailable` when the server has push off or refuses.
 */
export async function enablePush(
  session: Session,
  env: { fetcher: Fetcher; push: PushManagerLike; permission: () => Promise<string> }
): Promise<'enabled' | 'denied' | 'unavailable'> {
  if ((await env.permission()) !== 'granted') {
    return 'denied'
  }
  const base = `/api/guilds/${session.guildId}/push`
  const headers = { authorization: `Bearer ${session.token}` }
  const key = await env.fetcher(`${base}/key`, { headers })
  const parsed = keyBody.safeParse(await key.json().catch(() => null))
  if (!key.ok || !parsed.success) {
    return 'unavailable'
  }
  const subscription = subscriptionJson.parse(
    (
      await env.push.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(Buffer.from(parsed.data.publicKey, 'base64url')),
      })
    ).toJSON()
  )
  const res = await env.fetcher(`${base}/subscriptions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }),
  })
  return res.ok ? 'enabled' : 'unavailable'
}
