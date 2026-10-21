import { useCallback, useEffect, useState } from 'react'
import { Badge, type Tone } from './Badge'
import {
  type CouncilSessionView,
  councilCostText,
  councilStatusLabel,
  councilVoteLabel,
  loadCouncilSessions,
  proposalPrefix,
} from './council'
import { shortenId } from './GuildId'
import { councilCount, useLiveEvents } from './live-events'
import type { Session } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/** Sessions per page. */
const PAGE = 10

const STATUS_TONE: Record<string, Tone> = {
  open: 'warn',
  escalated: 'warn',
  approved: 'ok',
  halted: 'danger',
}

/** The Seal a session waits on, linked by id (a uuid the server made; the href is built, not echoed). */
function sealHref(id: string): string {
  return `/seals?seal=${encodeURIComponent(id)}`
}

function SessionDetail({ session }: { session: CouncilSessionView }) {
  return (
    <section aria-label="Council session" data-testid="council-detail" className="work-note mt-4">
      <h3>
        Proposal {proposalPrefix(session.proposalHash)} for Quest {session.questId}
      </h3>
      {session.reason !== null && <p className="muted">Escalated because: {session.reason}</p>}
      {session.votes.length === 0 ? (
        <p className="muted">No elder has voted yet.</p>
      ) : (
        <ul aria-label="Votes" className="flex flex-col gap-2">
          {session.votes.map((v) => (
            <li key={v.voice}>
              <strong>{v.voice}</strong> <Badge tone="neutral">{councilVoteLabel(v.vote)}</Badge>
              {v.abstainCode !== null && <span className="muted"> ({v.abstainCode})</span>}
              {v.reasons.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {session.status === 'escalated' && session.sealId !== null && (
        <p>
          <a href={sealHref(session.sealId)}>Review the Seal</a>
        </p>
      )}
    </section>
  )
}

/**
 * The Council of Elders' chamber ledger: recent sessions newest first, a page at a time, each with
 * its Proposal hash prefix, Quest, outcome and cost, opening to every elder's vote and reasons.
 * Escalated sessions link to their Seal. Reasons are model text and render as text only.
 */
export function CouncilPanel({ session }: { session: Session | null }) {
  const [rows, setRows] = useState<CouncilSessionView[]>([])
  const [next, setNext] = useState<string | null>(null)
  // A link from the "While you were away" scroll names the session to open (`?session=<id>`).
  const [openId, setOpenId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('session')
  )
  const [failed, setFailed] = useState(false)
  const changed = councilCount(useLiveEvents())

  useEffect(() => {
    if (!session || changed < 0) {
      return
    }
    let live = true
    loadCouncilSessions(session, fetch, { limit: PAGE })
      .then((got) => {
        if (live) {
          setRows(got.sessions)
          setNext(got.next)
          setFailed(false)
        }
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [session, changed])

  const older = useCallback(() => {
    if (!session || next === null) {
      return
    }
    loadCouncilSessions(session, fetch, { limit: PAGE, after: next })
      .then((got) => {
        setRows((current) => [...current, ...got.sessions])
        setNext(got.next)
      })
      .catch(() => setFailed(true))
  }, [session, next])

  const opened = rows.find((r) => r.id === openId) ?? null
  return (
    <WorkSection id="council" title="Council of Elders">
      {!session && <p>Sign in as the Guild Master to see the Council.</p>}
      {failed && <p role="alert">The Council's ledger could not be read.</p>}
      {session && rows.length === 0 && !failed && (
        <p className="muted mt-4">The elders have not been convened yet.</p>
      )}
      {opened !== null ? (
        <>
          <SessionDetail session={opened} />
          <PixelButton className="mt-2" onClick={() => setOpenId(null)}>
            Back to the list
          </PixelButton>
        </>
      ) : (
        rows.length > 0 && (
          <ul aria-label="Council sessions" className="mt-4 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid="council-row"
                className="flex flex-wrap items-center gap-2"
              >
                <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>
                  {councilStatusLabel(row.status)}
                </Badge>
                <span className="min-w-0 flex-1 basis-40">
                  Proposal {proposalPrefix(row.proposalHash)} · Quest {shortenId(row.questId)} ·{' '}
                  {councilCostText(row.costMicros)}
                </span>
                <PixelButton onClick={() => setOpenId(row.id)}>Open</PixelButton>
              </li>
            ))}
          </ul>
        )
      )}
      {next !== null && opened === null && (
        <PixelButton className="mt-4" onClick={older}>
          Load older
        </PixelButton>
      )}
    </WorkSection>
  )
}
