import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AWAY_REOPEN_EVENT,
  AWAY_RETURNED_EVENT,
  type AwayDigestPage,
  type DigestEntry,
  digestLine,
  loadAwayDigest,
  markScrollSeen,
  scrollSeen,
} from './away-digest'
import { shortenId } from './GuildId'
import type { Session } from './passkeys'
import { loadPresence } from './presence'
import { formatCents } from './treasury'
import { Frame, PixelButton } from './ui/pixel'

/** Props of {@link AwayScroll}. */
export interface AwayScrollProps {
  session: Session
  /** Opens one Council session's votes in the Council panel. */
  onOpenCouncil: (sessionId: string) => void
  /** Called each time the scroll opens, so the Bag can step aside and nothing shows through. */
  onShow?: (() => void) | undefined
}

/** Entries one page of the scroll holds. */
const PAGE = 25
/** Longest a timer may wait (a browser timer overflows past about 24 days). */
const MAX_WAIT_MS = 2_147_000_000

function whenText(iso: string): string {
  return new Date(iso).toLocaleString()
}

function Entry({
  entry,
  onOpenCouncil,
}: {
  entry: DigestEntry
  onOpenCouncil: (sessionId: string) => void
}) {
  const council = entry.kind === 'council_approved' || entry.kind === 'escalated'
  return (
    <li className="away-scroll-entry">
      <span className="away-scroll-text">
        {digestLine(entry)}
        {entry.questId !== null && (
          <span className="muted"> Quest {shortenId(entry.questId)}.</span>
        )}
        <span className="muted"> {whenText(entry.occurredAt)}</span>
      </span>
      {council && entry.sessionId !== null && (
        <PixelButton onClick={() => onOpenCouncil(entry.sessionId ?? '')}>Open votes</PixelButton>
      )}
    </li>
  )
}

/**
 * The "While you were away" scroll: a modal parchment listing what happened between going away and
 * returning (Council approvals, escalations with their reason, Seals still waiting, Quests done and
 * Treasury spend), a page at a time. It opens once per window on return (the tap in the HUD or the
 * Bag, or a return time noticed on load) and is remembered per viewer in localStorage. The Bag can
 * ask for it again. Each Council line opens its votes in the Council panel.
 */
export function AwayScroll({ session, onOpenCouncil, onShow }: AwayScrollProps) {
  void onShow
  const dialog = useRef<HTMLDialogElement>(null)
  const [shown, setShown] = useState(false)
  const [page, setPage] = useState<AwayDigestPage | null>(null)
  const [failed, setFailed] = useState(false)

  // Reads the digest and opens the scroll when this return has not been shown yet (or `force`).
  // Resolves to the return time while the Guild Master is still away, so the caller can wait for it.
  const check = useCallback(
    async (force: boolean): Promise<string | null> => {
      try {
        if (!force) {
          const presence = await loadPresence(session, fetch)
          if (presence.away) {
            return presence.until
          }
        }
        const got = await loadAwayDigest(session, fetch, { limit: PAGE })
        setPage(got)
        setFailed(false)
        if (force) {
          setShown(true)
        } else if (got.window && !got.window.open && !scrollSeen(session, got.window.since)) {
          markScrollSeen(session, got.window.since)
          setShown(true)
        }
      } catch {
        if (force) {
          setFailed(true)
          setShown(true)
        }
      }
      return null
    },
    [session]
  )

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = (force: boolean) => {
      clearTimeout(timer)
      check(force).then((until) => {
        if (live && until !== null) {
          // Still away with a return time: look again when it passes.
          const wait = new Date(until).getTime() - Date.now() + 1000
          timer = setTimeout(() => run(false), Math.min(Math.max(wait, 1000), MAX_WAIT_MS))
        }
      })
    }
    const onReturned = () => run(false)
    const onReopen = () => run(true)
    window.addEventListener(AWAY_RETURNED_EVENT, onReturned)
    window.addEventListener(AWAY_REOPEN_EVENT, onReopen)
    run(false)
    return () => {
      live = false
      clearTimeout(timer)
      window.removeEventListener(AWAY_RETURNED_EVENT, onReturned)
      window.removeEventListener(AWAY_REOPEN_EVENT, onReopen)
    }
  }, [check])

  useEffect(() => {
    const node = dialog.current
    if (!node) {
      return
    }
    if (shown && !node.open) {
      node.showModal()
    } else if (!shown && node.open) {
      node.close()
    }
  }, [shown])

  const close = () => setShown(false)
  const more = () => {
    if (page?.next == null) {
      return
    }
    loadAwayDigest(session, fetch, { limit: PAGE, after: page.next })
      .then((got) =>
        setPage((current) =>
          current ? { ...got, entries: [...current.entries, ...got.entries] } : got
        )
      )
      .catch(() => setFailed(true))
  }

  return (
    <dialog
      ref={dialog}
      className="away-scroll"
      aria-labelledby="away-scroll-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <Frame variant="paper" className="bag-frame">
        <div className="bag-head">
          <h2 id="away-scroll-title" className="bag-title">
            While you were away
          </h2>
          <div className="bag-actions">
            <PixelButton onClick={close}>Close</PixelButton>
          </div>
        </div>
        <div className="bag-body">
          {failed && <p role="alert">The scroll could not be read.</p>}
          {page?.window && (
            <p className="muted">
              {whenText(page.window.since)}
              {page.window.until !== null && <> to {whenText(page.window.until)}</>}
            </p>
          )}
          {page !== null && page.entries.length === 0 && !failed && (
            <p>Nothing happened while you were away.</p>
          )}
          {page !== null && page.entries.length > 0 && (
            <ul aria-label="While you were away" className="away-scroll-list">
              {page.entries.map((entry) => (
                <Entry
                  key={entry.seq}
                  entry={entry}
                  onOpenCouncil={(id) => {
                    close()
                    onOpenCouncil(id)
                  }}
                />
              ))}
            </ul>
          )}
          {page !== null && page.spendTotalCents > 0 && (
            <p>Treasury spend in all: {formatCents(page.spendTotalCents)}</p>
          )}
          {page?.next != null && (
            <PixelButton className="mt-4" onClick={more}>
              Load more
            </PixelButton>
          )}
        </div>
      </Frame>
    </dialog>
  )
}
