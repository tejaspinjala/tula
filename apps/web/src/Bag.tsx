import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ArchivePanel } from './ArchivePanel'
import { ArtifactViewer } from './ArtifactViewer'
import { AwayPanel } from './AwayPanel'
import { BuilderPanel } from './builder/BuilderPanel'
import { CostTablePanel } from './CostTablePanel'
import { CouncilPanel } from './CouncilPanel'
import { CharterPanel } from './charters/CharterPanel'
import { GatesPanel } from './GatesPanel'
import { GuildMapPanel } from './GuildMapPanel'
import type { GuildMap } from './game/guildmap'
import type { MapKey } from './game/world'
import { LearningPanel } from './LearningPanel'
import { MailboxPanel } from './MailboxPanel'
import { MissivesPanel } from './MissivesPanel'
import { PasskeyPanel } from './PasskeyPanel'
import { ProposalPanel } from './ProposalPanel'
import { ProvidersPanel } from './ProvidersPanel'
import type { Session } from './passkeys'
import { QuestBoardPanel } from './QuestBoardPanel'
import { RosterPanel } from './RosterPanel'
import { RitePanel } from './rites/RitePanel'
import { BAG_PAGES, type PageId } from './router'
import { SealPanel } from './SealPanel'
import { SummonPanel } from './SummonPanel'
import { TimelinePanel } from './TimelinePanel'
import { TreasuryPanel } from './TreasuryPanel'
import { TripwirePanel } from './TripwirePanel'
import { CursorMenu, Frame, PixelButton, ThemeControls } from './ui/pixel'
import { VaultPanel } from './VaultPanel'
import { FlatWorkContext } from './WorkSection'

/** Props of {@link Bag}. */
export interface BagProps {
  session: Session
  onSession: (session: Session | null) => void
  /** Whether the Bag overlay is showing (the menu, or a page when `page` is set). */
  visible: boolean
  page: PageId | null
  /** The Hall tools page content (zoom, teleport, replay, character). */
  hallControls: ReactNode
  onOpenPath: (path: string) => void
  /** Back to the Bag menu. */
  onMenu: () => void
  /** Close the Bag and return to the walk. */
  onClose: () => void
  onSignOut: () => void
  /** Returns keyboard focus to the world. */
  focusWorld: () => void
  /** Closes the Bag and opens the talk conversation with a Member (Missives' Talk). */
  onTalkTo?: ((memberId: string) => void) | undefined
  /** Reloads the Hall after the guild config changed (a Charter import). */
  onConfigChanged?: (() => void) | undefined
  /** The Guild Map the map page draws (null until the Hall's rooms are built). */
  map?: GuildMap | null | undefined
  /** Travels the Guild Master to a room from the map page. */
  onTravel?: ((id: MapKey) => void) | undefined
}

const HALL_TOOLS = 'hall-tools'
const SIGN_OUT = 'sign-out'

const MENU = [
  ...BAG_PAGES.map((p) => ({ id: p.id as string, label: p.label })),
  { id: HALL_TOOLS, label: 'Hall tools' },
  { id: SIGN_OUT, label: 'Sign out' },
]

function PageBody({
  page,
  session,
  onSession,
  onTalkTo,
  onConfigChanged,
  onSetupRouting,
  map,
  onTravel,
}: {
  page: PageId
  session: Session
  onSession: (session: Session | null) => void
  onTalkTo?: ((memberId: string) => void) | undefined
  onConfigChanged?: (() => void) | undefined
  onSetupRouting?: (() => void) | undefined
  map?: GuildMap | null | undefined
  onTravel?: ((id: MapKey) => void) | undefined
}) {
  switch (page) {
    case 'map':
      return <GuildMapPanel map={map ?? null} onTravel={(id) => onTravel?.(id)} />
    case 'quests':
      return <QuestBoardPanel session={session} onSetupRouting={onSetupRouting} />
    case 'seals':
      return <SealPanel session={session} />
    case 'treasury':
      return (
        <>
          <TreasuryPanel session={session} />
          <CostTablePanel session={session} />
        </>
      )
    case 'ledger':
      return (
        <>
          <TimelinePanel session={session} />
          <ArchivePanel session={session} />
          <ArtifactViewer session={session} />
          <LearningPanel session={session} />
          <ProposalPanel session={session} />
        </>
      )
    case 'guild':
      return (
        <>
          <BuilderPanel session={session} />
          <RosterPanel session={session} />
          <SummonPanel session={session} onSetupRouting={onSetupRouting} />
        </>
      )
    case 'rites':
      return <RitePanel session={session} />
    case 'charter':
      return <CharterPanel session={session} onConfigChanged={onConfigChanged} />
    case 'missives':
      return <MissivesPanel session={session} onTalk={onTalkTo} />
    case 'mailbox':
      return <MailboxPanel session={session} />
    case 'council':
      return <CouncilPanel session={session} />
    case 'gates':
      return (
        <>
          <GatesPanel session={session} />
          <TripwirePanel session={session} />
        </>
      )
    case 'settings':
      return (
        <>
          <AwayPanel session={session} />
          <ProvidersPanel session={session} />
          <ThemeControls />
          <VaultPanel session={session} />
          <PasskeyPanel session={session} onSession={onSession} />
        </>
      )
  }
}

/**
 * The Bag: a ▶ menu of pages, each opening as a framed overlay over a dimmed world. It is a modal
 * dialog, so the walk keys stay with the world until it closes; Esc closes it from the menu or from
 * any page, and keyboard focus then returns to the world.
 */
export function Bag({
  session,
  onSession,
  visible,
  page,
  hallControls,
  onOpenPath,
  onMenu,
  onClose,
  onSignOut,
  focusWorld,
  onTalkTo,
  onConfigChanged,
  map,
  onTravel,
}: BagProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const wasVisible = useRef(false)
  const world = useRef(focusWorld)
  world.current = focusWorld
  const [hall, setHall] = useState(false)

  useEffect(() => {
    const node = dialog.current
    if (!node) {
      return
    }
    if (visible && !node.open) {
      node.showModal()
      // A real browser focuses the first control (Close); the ▶ cursor belongs on the menu.
      node.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus()
    } else if (!visible && node.open) {
      node.close()
    }
    if (!visible && wasVisible.current) {
      setHall(false)
      world.current()
    }
    wasVisible.current = visible
  }, [visible])

  const heading = useRef<HTMLHeadingElement>(null)
  const title = hall ? 'Hall tools' : (BAG_PAGES.find((p) => p.id === page)?.label ?? 'Bag')
  const inMenu = page === null && !hall
  const size = BAG_PAGES.find((p) => p.id === page)?.size ?? 'menu'

  // Choosing a page replaces the menu the cursor was on: keyboard focus follows to the page title.
  useEffect(() => {
    if (visible && !inMenu) {
      // The Guild Map is a cursor widget: its ▶ cursor takes focus so the arrow keys work at once.
      const cursor =
        page === 'map'
          ? dialog.current?.querySelector<HTMLElement>('[data-room][tabindex="0"]')
          : null
      ;(cursor ?? heading.current)?.focus()
    }
  }, [visible, inMenu, page])

  const select = (id: string) => {
    if (id === SIGN_OUT) {
      onSignOut()
    } else if (id === HALL_TOOLS) {
      setHall(true)
    } else {
      const target = BAG_PAGES.find((p) => p.id === id)
      if (target) {
        onOpenPath(target.path)
      }
    }
  }
  const back = () => {
    setHall(false)
    onMenu()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="bag"
      data-size={size}
      aria-labelledby={page ? `${page}-title` : 'bag-title'}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <Frame variant={inMenu ? 'dialog' : 'wood'} className="bag-frame">
        <div className="bag-head">
          <h2
            id={page ? `${page}-title` : 'bag-title'}
            className="bag-title"
            ref={heading}
            tabIndex={-1}
          >
            {title}
          </h2>
          <div className="bag-actions">
            {!inMenu && <PixelButton onClick={back}>Back to the Bag</PixelButton>}
            <PixelButton onClick={onClose}>Close</PixelButton>
          </div>
        </div>
        {inMenu && <CursorMenu label="Bag" items={MENU} onSelect={select} autoFocus />}
        {hall && <div className="bag-body">{hallControls}</div>}
        {page !== null && (
          <div className="bag-body">
            <FlatWorkContext.Provider value>
              <PageBody
                page={page}
                session={session}
                onSession={onSession}
                onTalkTo={onTalkTo}
                onConfigChanged={onConfigChanged}
                map={map}
                onTravel={onTravel}
                onSetupRouting={() => onOpenPath('/vault')}
              />
            </FlatWorkContext.Provider>
          </div>
        )}
      </Frame>
    </dialog>
  )
}
