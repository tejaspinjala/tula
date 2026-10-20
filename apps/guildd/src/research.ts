import { researchCap } from './guild-config'
import { OutboundTimeout, withOutbound } from './outbound'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import { type PageFetcher, PageRefused } from './ports/page-fetcher'
import type { Quest } from './ports/quest-queue'
import type { ResearchStore } from './ports/research-store'
import type { SearchProvider } from './ports/search-provider'
import type { Treasury } from './treasury'

/** Most results one research call returns. */
export const MAX_RESEARCH_RESULTS = 3
/** Longest extract of one result, in characters. */
export const MAX_EXTRACT_CHARS = 1000
/** Longest title of one result, in characters. */
export const MAX_TITLE_CHARS = 200

/** Why a research call was refused or failed; nothing is charged for any of them. */
export type ResearchError =
  | 'research_cap'
  | 'provider_not_private_eligible'
  | 'research_declined'
  | 'research_timeout'
  | 'research_failed'

/** One result of a research call; every field is untrusted text from the web. */
export interface ResearchResult {
  title: string
  url: string
  extract: string
  /** Why the page could not be read (the extract is then the search snippet); a closed, short reason. */
  note?: string
}

/** The outcome of a research call. */
export type ResearchOutcome =
  | { ok: true; results: ResearchResult[]; chargedCents: number }
  | { ok: false; error: ResearchError }

/** What {@link Research} is built from. */
export interface ResearchDeps {
  search: SearchProvider
  fetcher: PageFetcher
  store: ResearchStore
  /** The Treasury the per-call charge goes through (a deterministic spend, never a model decision). */
  treasury: Pick<Treasury, 'requestSpend' | 'settleSpend' | 'releaseSpend' | 'denySpend'>
  config: ConfigStore
  clock: Clock
  /** Paper cents charged for one call; 0 charges nothing. */
  costCents: number
  /** Each outbound attempt is abandoned after this; defaults to ten seconds. */
  timeoutMs?: number
  /** Retries after a failed attempt; defaults to two. */
  retries?: number
  /** Base of the retry backoff in milliseconds; defaults to 250. */
  backoffMs?: number
  /** Jitter source in [0, 1); defaults to `Math.random`. */
  random?: () => number
  /** Waits; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
}

/** The actor a sweep's releases are recorded under. */
const SWEEP_ACTOR = 'research-sweep'

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The page URL as a normalised https URL, or null for anything else. */
function httpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Governed web research (ADR-0010). For one leased Quest it enforces, in code and in this order:
 * the private-routing rule (a private-class Quest never sends a query to a provider that is not
 * private-eligible), the per-Quest call cap (an atomic slot in the {@link ResearchStore}), and the
 * Treasury charge. Only then does it search and fetch, with a timeout and jittered retries on every
 * outbound call. A failure after the charge gives the charge back but keeps the slot (a failed call counts toward the cap). No model is called, and
 * nothing fetched is executed: the results are text for the gateway to return as untrusted data.
 */
export class Research {
  private readonly policy
  constructor(private readonly deps: ResearchDeps) {
    this.policy = {
      timeoutMs: deps.timeoutMs ?? 10_000,
      retries: deps.retries ?? 2,
      backoffMs: deps.backoffMs ?? 250,
      random: deps.random ?? Math.random,
      sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    }
  }

  /** Runs one research call for `quest`, made by `member`, in `guildId`. */
  async run(
    guildId: string,
    caller: { quest: Quest; member: string },
    query: string
  ): Promise<ResearchOutcome> {
    const { search, store, treasury, costCents } = this.deps
    const { quest, member } = caller
    if (quest.dataClass === 'private' && !search.privateEligible) {
      return { ok: false, error: 'provider_not_private_eligible' }
    }
    const { config } = await this.deps.config.current(guildId)
    const slot = await store.reserve(guildId, {
      hallId: quest.hallId,
      questId: quest.id,
      memberId: member,
      maxPerQuest: researchCap(config),
      at: this.deps.clock.now(),
    })
    if (!slot.ok) {
      return { ok: false, error: slot.error }
    }
    let spendId: string | null = null
    if (costCents > 0) {
      const spend = await treasury.requestSpend(guildId, {
        key: `research:${slot.call.id}`,
        amountCents: costCents,
        purpose: 'research',
        requestedBy: member,
      })
      if (!spend.ok || spend.spend.status !== 'reserved') {
        if (spend.ok) {
          await treasury.denySpend(guildId, spend.spend.id, member)
        }
        await store.release(guildId, slot.call.id)
        return { ok: false, error: 'research_declined' }
      }
      spendId = spend.spend.id
      await store.attachSpend(guildId, slot.call.id, spendId)
    }
    try {
      const results = await this.query(query)
      if (spendId !== null) {
        await treasury.settleSpend(guildId, spendId, costCents, member)
      }
      await store.settle(guildId, slot.call.id)
      return { ok: true, results, chargedCents: spendId === null ? 0 : costCents }
    } catch (error) {
      if (spendId !== null) {
        await treasury.releaseSpend(guildId, spendId, member)
      }
      await store.settle(guildId, slot.call.id)
      // The slot stays: a failed call counts toward the cap, so a Member looping on a down
      // provider reaches `research_cap` and cannot hammer it. Only the charge is given back.
      return {
        ok: false,
        error: error instanceof OutboundTimeout ? 'research_timeout' : 'research_failed',
      }
    }
  }

  /**
   * Frees the slots, and releases the Treasury spends, that a crash between reserve and settle
   * left behind: a call still unsettled after the outbound deadline cannot be in flight. Runs
   * under the guild's sweep lock and is idempotent (a freed slot is never visited twice and a
   * released spend stays released). Returns how many slots it freed.
   */
  async sweep(guildId: string): Promise<number> {
    const before = new Date(this.deps.clock.now().getTime() - this.deadlineMs())
    return this.deps.store.sweep(guildId, before, async (spendId) => {
      await this.deps.treasury.releaseSpend(guildId, spendId, SWEEP_ACTOR)
    })
  }

  /** The longest a call can run: a search, then fetches, each with retries, timeouts and backoff. */
  private deadlineMs(): number {
    const { timeoutMs, retries, backoffMs } = this.policy
    const stage = (retries + 1) * timeoutMs + backoffMs * (2 ** retries - 1) * 2
    return 2 * stage + 60_000
  }

  private async query(query: string): Promise<ResearchResult[]> {
    const hits = await withOutbound(this.policy, (signal) =>
      this.deps.search.search(query, { limit: MAX_RESEARCH_RESULTS, signal })
    )
    const usable = hits.flatMap((hit) => {
      const url = httpsUrl(hit.url)
      return url === null ? [] : [{ hit, url }]
    })
    return Promise.all(
      usable.slice(0, MAX_RESEARCH_RESULTS).map(async ({ hit, url }) => {
        let page = ''
        let note: string | undefined
        try {
          page = await withOutbound(
            this.policy,
            (signal) => this.deps.fetcher.fetch(url, { signal }),
            (error) => !(error instanceof PageRefused)
          )
        } catch (error) {
          note = error instanceof PageRefused ? `page_skipped: ${error.code}` : 'page_unavailable'
        }
        const text = collapse(page) || collapse(hit.snippet)
        return {
          title: collapse(hit.title).slice(0, MAX_TITLE_CHARS),
          url,
          extract: text.slice(0, MAX_EXTRACT_CHARS),
          ...(note === undefined ? {} : { note }),
        }
      })
    )
  }
}
