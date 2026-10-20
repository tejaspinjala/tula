import { learningRepoAllowlist } from './guild-config'
import { extractSuggestions } from './learning'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import { EnvoyError, type EnvoyErrorCode, type GitHubEnvoy } from './ports/github-envoy'
import type { Note, NoteStore } from './ports/note-store'
import type {
  Suggestion,
  SuggestionPage,
  SuggestionStatus,
  SuggestionStore,
} from './ports/suggestion-store'

/** What one scan did: repos tried, new suggestions stored, and repos that failed (by code only). */
export interface ScanResult {
  repos: number
  added: number
  failed: Array<{ repo: string; code: EnvoyErrorCode | 'deadline' }>
}

/** Result of accepting or dismissing a suggestion. */
export type DecisionResult =
  | { ok: true; suggestion: Suggestion; note?: Note }
  | { ok: false; reason: 'not_found' | 'already_decided' }

/**
 * Weekly learning suggestions: reads the allowlisted repos through the read-only Envoy, turns merged
 * pull request titles and descriptions and ADR file titles into suggestions with the pure
 * extraction, and lets the Guild Master accept (an Archive note) or dismiss each. Nothing here
 * calls a model, and no job state lives in the process: a scan is a plain call a schedule or a
 * route makes.
 */
export class LearningEngine {
  private readonly store: SuggestionStore
  private readonly envoy: GitHubEnvoy
  private readonly config: ConfigStore
  private readonly notes: NoteStore

  constructor(deps: {
    store: SuggestionStore
    envoy: GitHubEnvoy
    config: ConfigStore
    notes: NoteStore
    /** Measures a scan against its deadline. */
    clock?: Clock
    /** Most milliseconds a scan may run before it stops reading further repos; defaults to 30000. */
    scanDeadlineMs?: number
  }) {
    this.store = deps.store
    this.envoy = deps.envoy
    this.config = deps.config
    this.notes = deps.notes
  }

  /**
   * Reads each allowlisted repo and stores the suggestions not seen before. A repo that fails is
   * reported and skipped; the rest are still read. Idempotent: running it twice adds nothing new.
   */
  async scan(guildId: string): Promise<ScanResult> {
    const { config } = await this.config.current(guildId)
    const repos = learningRepoAllowlist(config)
    const result: ScanResult = { repos: repos.length, added: 0, failed: [] }
    for (const repo of repos) {
      try {
        const pulls = await this.envoy.mergedPulls(guildId, repo)
        const adrs = await this.envoy.adrEntries(guildId, repo)
        result.added += await this.store.addMany(guildId, extractSuggestions({ repo, pulls, adrs }))
      } catch (error) {
        if (!(error instanceof EnvoyError)) {
          throw error
        }
        result.failed.push({ repo, code: error.code })
      }
    }
    return result
  }

  /** Suggestions in id order, optionally only those in `status`. */
  list(
    guildId: string,
    page: { after?: string; limit: number; status?: SuggestionStatus }
  ): Promise<SuggestionPage> {
    return this.store.list(guildId, page)
  }

  /**
   * Accepts a pending suggestion: claims it first (so a second accept cannot also write a note),
   * then files an Archive note under no Hall (the Guild Master's own) as an assumption, since it
   * comes from PR text. If the note cannot be written the suggestion returns to pending.
   */
  async accept(guildId: string, id: string): Promise<DecisionResult> {
    const decided = await this.store.decide(guildId, id, 'accepted')
    if (!decided.ok) {
      return decided
    }
    const { suggestion } = decided
    try {
      const note = await this.notes.add(guildId, {
        kind: 'text',
        title: suggestion.title,
        body: `${suggestion.body}\n\nSource: ${suggestion.url}`,
        claim: 'assumption',
      })
      await this.store.recordNote(guildId, id, note.id)
      return { ok: true, suggestion: { ...suggestion, noteId: note.id }, note }
    } catch (error) {
      await this.store.reopen(guildId, id)
      throw error
    }
  }

  /** Dismisses a pending suggestion for good: it is never suggested again. */
  async dismiss(guildId: string, id: string): Promise<DecisionResult> {
    return this.store.decide(guildId, id, 'dismissed')
  }
}
