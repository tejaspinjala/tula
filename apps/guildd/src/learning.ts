import type { AdrEntry, MergedPull } from './ports/github-envoy'
import type { NewSuggestion } from './ports/suggestion-store'

const MAX_TITLE = 200
const MAX_BODY = 4000

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** The ADR number and a readable title from a file name like `0007-use-row-level-security.md`. */
function adrTitle(name: string): { number: string; title: string } | null {
  const match = /^(\d{1,6})-([a-z0-9][a-z0-9-]*)\.md$/i.exec(name)
  const number = match?.[1]
  const slug = match?.[2]
  if (number === undefined || slug === undefined) {
    return null
  }
  const words = slug.replaceAll('-', ' ')
  return { number, title: words.charAt(0).toUpperCase() + words.slice(1) }
}

/**
 * Pure and deterministic: turns the merged pull requests and ADR file names of one repo into
 * suggested learnings, ordered by source id. The same input always gives the same suggestions. No
 * model is involved; a suggestion is only text lifted from titles and descriptions.
 */
export function extractSuggestions(input: {
  repo: string
  pulls: readonly MergedPull[]
  adrs: readonly AdrEntry[]
}): NewSuggestion[] {
  const { repo } = input
  const found = new Map<string, NewSuggestion>()
  for (const pull of input.pulls) {
    const description = (pull.body ?? '').replaceAll('\r\n', '\n').trim()
    const sourceId = `pr:${repo}#${pull.number}`
    found.set(sourceId, {
      sourceId,
      repo,
      kind: 'pr',
      title: clip(`${repo}#${pull.number}: ${pull.title.trim()}`, MAX_TITLE),
      body: clip(
        description === ''
          ? `Merged pull request: ${pull.title.trim()}`
          : `Merged pull request: ${pull.title.trim()}\n\n${description}`,
        MAX_BODY
      ),
      url: pull.url,
    })
  }
  for (const adr of input.adrs) {
    const parsed = adrTitle(adr.name)
    if (!parsed) {
      continue
    }
    const sourceId = `adr:${repo}:${adr.path}`
    found.set(sourceId, {
      sourceId,
      repo,
      kind: 'adr',
      title: clip(`ADR ${parsed.number}: ${parsed.title}`, MAX_TITLE),
      body: `A new decision record in ${repo}: ADR ${parsed.number}, ${parsed.title}.`,
      url: `https://github.com/${repo}/blob/HEAD/${adr.path}`,
    })
  }
  return [...found.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1))
}
