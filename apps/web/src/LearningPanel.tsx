import { useCallback, useEffect, useState } from 'react'
import { decideSuggestion, loadSuggestions, type SuggestionView, scanLearning } from './learning'
import type { Session } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

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
    <WorkSection id="learning" title="Ledger of Deeds">
      {!session && <p>Sign in with a passkey to see suggested learnings.</p>}
      {failed && <p role="alert">Suggested learnings could not be loaded.</p>}
      {message && <p role="status">{message}</p>}
      {session && items.length === 0 && !failed && <p>No suggestions are waiting.</p>}
      <ul aria-label="Suggestions" className="ledger-book">
        {items.map((item) => (
          <li key={item.id} className="work-note">
            {item.url === null ? (
              <span>{item.title}</span>
            ) : (
              <a href={item.url} rel="noreferrer noopener" target="_blank">
                {item.title}
              </a>
            )}
            <p>{item.body}</p>
            <div className="work-actions">
              <PixelButton onClick={() => decide(item.id, 'accept')}>
                Accept {item.title}
              </PixelButton>
              <PixelButton onClick={() => decide(item.id, 'dismiss')}>
                Dismiss {item.title}
              </PixelButton>
            </div>
          </li>
        ))}
      </ul>
      {session && <PixelButton onClick={scan}>Scan repos now</PixelButton>}
    </WorkSection>
  )
}
