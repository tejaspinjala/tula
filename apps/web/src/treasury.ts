import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const overviewBody = z.object({
  mode: z.literal('paper'),
  balances: z.object({ operating: z.number(), reserve: z.number(), profit: z.number() }),
  spentTodayCents: z.number(),
  day: z.string(),
  limits: z.object({ dailyCapCents: z.number(), treasurerLimitCents: z.number() }),
})
const entryBody = z.object({
  seq: z.number(),
  kind: z.string(),
  bucket: z.string(),
  amountCents: z.number(),
})
const pageBody = z.object({ items: z.array(entryBody), next: z.number().nullable() })
const chainBody = z.union([
  z.object({ intact: z.literal(true), entries: z.number() }),
  z.object({ intact: z.literal(false), firstBadSeq: z.number(), reason: z.string() }),
])

/** One ledger entry. */
export type EntryView = z.infer<typeof entryBody>

/** The Treasury as the Treasury screen shows it. */
export interface TreasuryView {
  overview: z.infer<typeof overviewBody>
  entries: EntryView[]
  chain: z.infer<typeof chainBody>
}

/** Most pages one load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

/** Integer cents as dollars. */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents)
  const text = `$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return cents < 0 ? `-${text}` : text
}

async function getJson(session: Session, fetcher: Fetcher, path: string): Promise<unknown> {
  const res = await fetcher(`/api/guilds/${session.guildId}/treasury${path}`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return data
}

/** The Treasury overview alone (the HUD's day and daily-cap meter), without the ledger pages. */
export async function loadTreasuryOverview(
  session: Session,
  fetcher: Fetcher
): Promise<TreasuryView['overview']> {
  return overviewBody.parse(await getJson(session, fetcher, ''))
}

/** Loads the overview, every ledger entry (following page cursors) and the hash-chain check. */
export async function loadTreasury(
  session: Session,
  fetcher: Fetcher,
  options: { limit?: number } = {}
): Promise<TreasuryView> {
  const overview = overviewBody.parse(await getJson(session, fetcher, ''))
  const entries: EntryView[] = []
  const limit = options.limit ?? 50
  let after: number | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=${limit}${after === null ? '' : `&after=${after}`}`
    const page = pageBody.parse(await getJson(session, fetcher, `/entries?${query}`))
    entries.push(...page.items)
    if (page.next === null) {
      const chain = chainBody.parse(await getJson(session, fetcher, '/verify'))
      return { overview, entries, chain }
    }
    after = page.next
  }
  throw new Error('too many ledger pages')
}

/** One line for a ledger entry. */
export function describeEntry(entry: EntryView): string {
  return `#${entry.seq} ${entry.kind.replaceAll('_', ' ')}: ${entry.bucket} ${formatCents(entry.amountCents)}`
}
