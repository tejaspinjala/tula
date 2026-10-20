import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const statusBody = z.object({
  complete: z.boolean(),
  steps: z.array(z.object({ id: z.enum(['provider', 'test_quest']), done: z.boolean() })),
  quest: z.object({ id: z.string(), state: z.string() }).nullable(),
})

/** Where "Summon your first member" stands. */
export type SummonStatus = z.infer<typeof statusBody>

async function call(
  fetcher: Fetcher,
  url: string,
  init: { method: 'GET' | 'POST'; token: string; body?: object }
): Promise<SummonStatus> {
  const res = await fetcher(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return statusBody.parse(data)
}

/** Reads where the check stands. */
export function loadSummon(session: Session, fetcher: Fetcher): Promise<SummonStatus> {
  return call(fetcher, `/api/guilds/${session.guildId}/summon`, {
    method: 'GET',
    token: session.token,
  })
}

/** Starts the check with the chosen routing profile. */
export function startSummon(
  session: Session,
  profileId: string,
  fetcher: Fetcher
): Promise<SummonStatus> {
  return call(fetcher, `/api/guilds/${session.guildId}/summon`, {
    method: 'POST',
    token: session.token,
    body: { profileId },
  })
}

/** One sentence on where the check stands; it is only complete once the test Quest has passed. */
export function describeSummon(status: SummonStatus): string {
  if (status.complete) {
    return 'Your first member is summoned: the test Quest passed on the worker.'
  }
  if (status.quest !== null && status.quest.state !== 'done') {
    return 'The test Quest is running on the worker.'
  }
  return 'Not summoned yet: the test Quest has not passed.'
}
