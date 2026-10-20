import { useEffect, useRef, useState } from 'react'
import type { Fetcher } from './artifacts'
import type { SceneMember, SceneState } from './game/scene'
import { hallTitle } from './game/walk'
import { activityFeed } from './inspect'
import { missiveCount } from './live-events'
import type { Session } from './passkeys'
import type { ReplayEvent } from './replay'
import { STATE_WORDS, useRecentMissives } from './TalkDialog'
import { Frame, PixelButton, Portrait } from './ui/pixel'

/** What the inspect card needs from the page. */
export interface InspectCardProps {
  session: Session
  fetcher: Fetcher
  /** The Member inspected, or null with the card closed. */
  memberId: string | null
  scene: SceneState | null
  quests: readonly { id: string; title: string; state?: string }[]
  events: readonly ReplayEvent[]
  onTalk: () => void
  onFollow: (memberId: string) => void
  onClose: () => void
}

/** Activity lines per page. */
const FEED_PAGE = 8

/**
 * A framed card on one Member: its Portrait, Hall and rank, the Quest in hand and the step it is
 * on, a live activity feed (newest first, a page at a time), its Missives (text read by route, never
 * from events), and Talk and Follow. A native modal `<dialog>`: focus is trapped, Esc closes it.
 */
export function InspectCard({
  session,
  fetcher,
  memberId,
  scene,
  quests,
  events,
  onTalk,
  onFollow,
  onClose,
}: InspectCardProps) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const member = memberId === null ? undefined : scene?.members[memberId]
  const shown = member !== undefined
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) {
      return
    }
    if (shown && !dialog.open) {
      dialog.showModal()
    } else if (!shown && dialog.open) {
      dialog.close()
    }
  }, [shown])
  return (
    <dialog
      ref={ref}
      className="bag inspect"
      aria-labelledby={shown ? 'inspect-title' : undefined}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {member && scene && (
        <Card
          key={member.id}
          session={session}
          fetcher={fetcher}
          member={member}
          scene={scene}
          quests={quests}
          events={events}
          onTalk={onTalk}
          onFollow={onFollow}
          onClose={onClose}
        />
      )}
    </dialog>
  )
}

function Card({
  session,
  fetcher,
  member,
  scene,
  quests,
  events,
  onTalk,
  onFollow,
  onClose,
}: Omit<InspectCardProps, 'memberId' | 'scene'> & {
  member: SceneMember
  scene: SceneState
}) {
  const [pages, setPages] = useState(1)
  const room = scene.rooms.find((r) => r.hallId === member.hallId)
  const quest = member.questId === null ? undefined : quests.find((q) => q.id === member.questId)
  const status = quest?.state ? (STATE_WORDS[quest.state] ?? quest.state) : member.status
  const feed = activityFeed(events, member.id, pages * FEED_PAGE)
  const step = feed.entries[0]?.label
  const messages = useRecentMissives(session, fetcher, member, missiveCount(events))
  const nameOf = (id: string): string => scene.members[id]?.name ?? id
  return (
    <Frame variant="wood" className="bag-frame">
      <div className="bag-head">
        <Portrait name={member.name} />
        <h2 id="inspect-title" className="bag-title">
          {member.name}
        </h2>
        <div className="bag-actions">
          <PixelButton onClick={onTalk}>Talk</PixelButton>
          <PixelButton onClick={() => onFollow(member.id)}>Follow this Member</PixelButton>
          <PixelButton onClick={onClose}>Close</PixelButton>
        </div>
      </div>
      <div className="bag-body">
        <dl className="talk-facts">
          <dt>Rank</dt>
          <dd>{member.rank}</dd>
          <dt>Hall</dt>
          <dd>{room ? hallTitle(room.name) : 'No Hall'}</dd>
          <dt>Quest</dt>
          <dd>{quest ? `${quest.title} (${status})` : `No Quest right now (${member.status})`}</dd>
          <dt>Step</dt>
          <dd>{step ?? 'Nothing yet'}</dd>
        </dl>
        <h3>Activity</h3>
        {feed.entries.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ul aria-label="Activity">
            {feed.entries.map((entry) => (
              <li key={entry.seq}>{entry.label}</li>
            ))}
          </ul>
        )}
        {feed.more && (
          <PixelButton onClick={() => setPages((n) => n + 1)}>Show older activity</PixelButton>
        )}
        <h3>Missives</h3>
        {messages.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <ul aria-label="Missives">
            {messages.map((m) => (
              <li key={m.id} data-testid="missive">
                <strong>{nameOf(m.from)}</strong> to {m.to === 'hall' ? 'the Hall' : nameOf(m.to)}:{' '}
                {m.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Frame>
  )
}
