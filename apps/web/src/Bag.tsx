import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ArchivePanel } from './ArchivePanel'
import { ArtifactViewer } from './ArtifactViewer'
import { BuilderPanel } from './builder/BuilderPanel'
import { CostTablePanel } from './CostTablePanel'
import { GatesPanel } from './GatesPanel'
import { LearningPanel } from './LearningPanel'
import { MissivesPanel } from './MissivesPanel'
import { PasskeyPanel } from './PasskeyPanel'
import { ProposalPanel } from './ProposalPanel'
import type { Session } from './passkeys'
import { QuestBoardPanel } from './QuestBoardPanel'
import { RosterPanel } from './RosterPanel'
import { BAG_PAGES, type PageId } from './router'
import { SealPanel } from './SealPanel'
import { SummonPanel } from './SummonPanel'
import { TimelinePanel } from './TimelinePanel'
import { TreasuryPanel } from './TreasuryPanel'
import { TripwirePanel } from './TripwirePanel'
import { CursorMenu, Frame, PixelButton, ThemeControls } from './ui/pixel'
import { VaultPanel } from './VaultPanel'
import { WorkflowPanel } from './workflows/WorkflowPanel'

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
  /** Closes the Bag and opens the talk conversation with a Member (the Guild chat's Talk). */
  onTalkTo?: ((memberId: string) => void) | undefined
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
}: {
  page: PageId
  session: Session
  onSession: (session: Session | null) => void
  onTalkTo?: ((memberId: string) => void) | undefined
}) {
  switch (page) {
    case 'quests':
      return <QuestBoardPanel session={session} />
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
          <SummonPanel session={session} />
        </>
      )
    case 'workflows':
      return <WorkflowPanel session={session} />
    case 'missives':
      return <MissivesPanel session={session} onTalk={onTalkTo} />
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

  const title = hall ? 'Hall tools' : (BAG_PAGES.find((p) => p.id === page)?.label ?? 'Bag')
  const inMenu = page === null && !hall

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
      aria-labelledby={page ? `${page}-title` : 'bag-title'}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <Frame variant={inMenu ? 'dialog' : 'wood'} className="bag-frame">
        <div className="bag-head">
          <h2 id={page ? `${page}-title` : 'bag-title'} className="bag-title">
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
            <PageBody page={page} session={session} onSession={onSession} onTalkTo={onTalkTo} />
          </div>
        )}
      </Frame>
    </dialog>
  )
}
