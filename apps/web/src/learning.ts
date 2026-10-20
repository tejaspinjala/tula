import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

/** The link target only when it is https on exactly github.com; anything else is no link. */
const githubUrl = z.string().transform((value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? value : null
  } catch {
    return null
  }
})

const suggestionBody = z.object({
  id: z.string(),
  sourceId: z.string(),
  repo: z.string(),
  kind: z.enum(['pr', 'adr']),
  title: z.string(),
  body: z.string(),
  url: githubUrl,
  status: z.enum(['pending', 'accepted', 'dismissed']),
  noteId: z.string().nullable(),
})
const pageBody = z.object({ suggestions: z.array(suggestionBody), next: z.string().nullable() })
const decisionBody = z.object({ suggestion: suggestionBody })
const scanBody = z.object({ repos: z.number(), added: z.number(), failed: z.array(z.unknown()) })

/** One suggested learning as the panel shows it. */
export type SuggestionView = z.infer<typeof suggestionBody>

/** Most pages one load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

async function call(
  session: Session,
  fetcher: Fetcher,
  path: string,
  init: { method: 'GET' | 'POST' }
): Promise<unknown> {
  const res = await fetcher(`/api/guilds/${session.guildId}/learning${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.method === 'POST' ? { body: '{}' } : {}),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return data
}

/** Loads every pending suggestion, following page cursors. */
export async function loadSuggestions(
  session: Session,
  fetcher: Fetcher,
  options: { limit?: number } = {}
): Promise<SuggestionView[]> {
  const all: SuggestionView[] = []
  const limit = options.limit ?? 50
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const cursor: string = after === null ? '' : `&after=${encodeURIComponent(after)}`
    const page = pageBody.parse(
      await call(session, fetcher, `/suggestions?status=pending&limit=${limit}${cursor}`, {
        method: 'GET',
      })
    )
    all.push(...page.suggestions)
    if (page.next === null) {
      return all
    }
    after = page.next
  }
  throw new Error('too many suggestion pages')
}

/** Accepts (files an Archive note) or dismisses (never suggested again) one suggestion. */
export async function decideSuggestion(
  session: Session,
  fetcher: Fetcher,
  id: string,
  verb: 'accept' | 'dismiss'
): Promise<SuggestionView> {
  const data = await call(session, fetcher, `/suggestions/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
  })
  return decisionBody.parse(data).suggestion
}

/** Triggers a scan of the allowlisted repos; reports repos tried, suggestions added, repos that failed. */
export async function scanLearning(
  session: Session,
  fetcher: Fetcher
): Promise<{ repos: number; added: number; failed: number }> {
  const scan = scanBody.parse(await call(session, fetcher, '/scan', { method: 'POST' }))
  return { repos: scan.repos, added: scan.added, failed: scan.failed.length }
}
