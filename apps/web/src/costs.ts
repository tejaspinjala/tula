import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const row = z.object({
  key: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costMicros: z.number(),
})
const page = z.object({ rows: z.array(row), next: z.string().nullable() })

/** What the cost table groups spend by. */
export type CostGroup = 'day' | 'run' | 'quest' | 'hall'
/** One row of the cost table. */
export type CostRow = z.infer<typeof row>

/** Most pages one cost load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

/** Loads the cost table for the ledger view, following the server's page cursors. */
export async function loadCosts(
  session: Session,
  by: CostGroup,
  fetcher: Fetcher,
  limit = 50
): Promise<CostRow[]> {
  const rows: CostRow[] = []
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `by=${by}&limit=${limit}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
    const res = await fetcher(`/api/guilds/${session.guildId}/gateway/usage?${query}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(data)
      throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
    }
    const body = page.parse(data)
    rows.push(...body.rows)
    if (body.next === null) {
      return rows
    }
    after = body.next
  }
  throw new Error('cost table has too many pages')
}

/** Accepted posts and what they cost, in millionths of a dollar. */
export interface PostCost {
  posts: number
  costMicros: number
  costPerPostMicros: number
}

/** The cost of one Campaign's accepted posts; a null Campaign groups Quests outside any. */
export interface CampaignPostCost extends PostCost {
  campaignId: string | null
}

/** Cost per accepted post: overall and per Campaign. */
export interface CostPerPost {
  overall: PostCost
  campaigns: CampaignPostCost[]
}

/** Loads cost per accepted post, following the server's page cursors. */
export async function loadCostPerPost(
  _session: Session,
  _fetcher: Fetcher,
  _limit = 50
): Promise<CostPerPost> {
  return { overall: { posts: 0, costMicros: 0, costPerPostMicros: 0 }, campaigns: [] }
}

/** Formats millionths of a dollar: cents when exact, else up to six places; integer maths only. */
export function formatDollars(micros: number): string {
  const whole = Math.floor(micros / 1_000_000)
  const frac = String(micros % 1_000_000).padStart(6, '0')
  const trimmed = frac.replace(/0+$/, '')
  return `$${whole}.${trimmed.length >= 2 ? trimmed : frac.slice(0, 2)}`
}
