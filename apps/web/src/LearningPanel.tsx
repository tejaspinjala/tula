import { useCallback, useEffect, useState } from 'react'
import { decideSuggestion, loadSuggestions, type SuggestionView, scanLearning } from './learning'
import type { Session } from './passkeys'

/**
 * Suggested learnings from merged pull requests and ADR titles in the repos the Guild Master
 * allowlisted. Each can be accepted (it becomes an Archive note, marked an assumption) or
 * dismissed (never suggested again). Nothing here calls a model.
 */
export function LearningPanel({ session }: { session: Session | null }) {
  const [items, setItems] = useState<SuggestionView[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    if (!session) {
      setItems([])
      return
    }
    loadSuggestions(session, fetch)
      .then((loaded) => {
        setItems(loaded)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [session])

  useEffect(refresh, [refresh])

  async function decide(id: string, verb: 'accept' | 'dismiss') {
    if (!session) {
      return
    }
    try {
      await decideSuggestion(session, fetch, id, verb)
      setMessage(verb === 'accept' ? 'Added to the Archive as an assumption.' : 'Dismissed.')
      refresh()
    } catch {
      setMessage('That suggestion could not be updated.')
    }
  }

  async function scan() {
    if (!session) {
      return
    }
    try {
      const result = await scanLearning(session, fetch)
      setMessage(
        `Read ${result.repos} repos, ${result.added} new suggestions${
          result.failed > 0 ? `, ${result.failed} repos failed` : ''
        }.`
      )
      refresh()
    } catch {
      setMessage('The repos could not be scanned.')
    }
  }

  return (
    <section aria-labelledby="learning-heading" className="mt-8">
      <h2 id="learning-heading" className="text-xl font-semibold">
        Suggested learnings
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see suggested learnings.</p>}
      {failed && <p role="alert">Suggested learnings could not be loaded.</p>}
      {message && <p role="status">{message}</p>}
      {session && items.length === 0 && !failed && (
        <p className="mt-4">No suggestions are waiting.</p>
      )}
      <ul aria-label="Suggestions" className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id}>
            {item.url === null ? (
              <span>{item.title}</span>
            ) : (
              <a href={item.url} rel="noreferrer noopener" target="_blank">
                {item.title}
              </a>
            )}
            <p>{item.body}</p>
            <button type="button" onClick={() => decide(item.id, 'accept')}>
              Accept {item.title}
            </button>{' '}
            <button type="button" onClick={() => decide(item.id, 'dismiss')}>
              Dismiss {item.title}
            </button>
          </li>
        ))}
      </ul>
      {session && (
        <button type="button" className="mt-4" onClick={scan}>
          Scan repos now
        </button>
      )}
    </section>
  )
}
