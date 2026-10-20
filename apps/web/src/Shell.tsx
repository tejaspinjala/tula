import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { ArchivePanel } from './ArchivePanel'
import { ArtifactViewer } from './ArtifactViewer'
import { BuilderPanel } from './builder/BuilderPanel'
import { CostTablePanel } from './CostTablePanel'
import { GamePanel } from './GamePanel'
import { GatesPanel } from './GatesPanel'
import { HomePanel } from './HomePanel'
import { LearningPanel } from './LearningPanel'
import { PasskeyPanel } from './PasskeyPanel'
import { ProposalPanel } from './ProposalPanel'
import type { Session } from './passkeys'
import { QuestBoardPanel } from './QuestBoardPanel'
import { RosterPanel } from './RosterPanel'
import { useRoute, VIEWS, type ViewId } from './router'
import { SealPanel } from './SealPanel'
import { SummonPanel } from './SummonPanel'
import { TimelinePanel } from './TimelinePanel'
import { TreasuryPanel } from './TreasuryPanel'
import { TripwirePanel } from './TripwirePanel'
import { VaultPanel } from './VaultPanel'
import { WorkflowPanel } from './workflows/WorkflowPanel'

/** How many views get their own tab on a phone; the rest sit behind More. */
const PHONE_TABS = 4

function ViewBody({
  view,
  session,
  onSession,
  navigate,
}: {
  view: ViewId
  session: Session
  onSession: (session: Session | null) => void
  navigate: (path: string) => void
}) {
  switch (view) {
    case 'home':
      return <HomePanel session={session} navigate={navigate} />
    case 'hall':
      return <GamePanel session={session} navigate={navigate} />
    case 'quests':
      return <QuestBoardPanel session={session} />
    case 'seals':
      return <SealPanel session={session} />
    case 'archive':
      return (
        <>
          <ArchivePanel session={session} />
          <ArtifactViewer session={session} />
          <LearningPanel session={session} />
          <ProposalPanel session={session} />
        </>
      )
    case 'treasury':
      return (
        <>
          <TreasuryPanel session={session} />
          <CostTablePanel session={session} />
        </>
      )
    case 'roster':
      return (
        <>
          <RosterPanel session={session} />
          <SummonPanel session={session} />
        </>
      )
    case 'guild':
      return <BuilderPanel session={session} />
    case 'workflows':
      return <WorkflowPanel session={session} />
    case 'gates':
      return (
        <>
          <GatesPanel session={session} />
          <TripwirePanel session={session} />
        </>
      )
    case 'timeline':
      return <TimelinePanel session={session} />
    case 'vault':
      return (
        <>
          <VaultPanel session={session} />
          <PasskeyPanel session={session} onSession={onSession} />
        </>
      )
  }
}

/**
 * The signed-in ledger: a header with the guild name, navigation (a left rail on desktop, a tab
 * bar on a phone) and exactly one active view.
 */
export function Shell({
  session,
  guildName,
  status,
  onSession,
}: {
  session: Session
  guildName: string
  status: 'checking' | 'ok' | 'down'
  onSession: (session: Session | null) => void
}) {
  const { view, navigate } = useRoute()
  const [moreOpen, setMoreOpen] = useState(false)
  const more = moreOpen ? 'open' : 'closed'
  const nav = useRef<HTMLElement | null>(null)
  const active = VIEWS.find((v) => v.id === view)
  const activeIndex = VIEWS.findIndex((v) => v.id === view)
  const go = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return
    }
    event.preventDefault()
    setMoreOpen(false)
    navigate(path)
  }
  useEffect(() => {
    document.title = `${active?.label ?? 'Ledger'} | Guildhall`
    nav.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const signOut = () => {
    navigate('/')
    onSession(null)
  }
  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="shell-header">
        <p className="brand">{guildName || 'Guildhall ledger'}</p>
        {status === 'down' && (
          <p role="alert" className="error-text">
            guildd: down
          </p>
        )}
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      <nav aria-label="Ledger" className="shell-nav" data-more={more} ref={nav}>
        <ul>
          {VIEWS.map((v, index) => (
            <li key={v.id} className={index >= PHONE_TABS ? 'nav-extra' : 'nav-tab'}>
              <a
                href={v.path}
                aria-current={v.id === view ? 'page' : undefined}
                onClick={go(v.path)}
              >
                {v.label}
              </a>
            </li>
          ))}
          <li className="nav-more">
            <button
              type="button"
              aria-expanded={moreOpen}
              data-active-inside={activeIndex >= PHONE_TABS ? 'true' : undefined}
              onClick={() => setMoreOpen((open) => !open)}
            >
              More
            </button>
          </li>
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="shell-main">
        <h1 id={view === 'home' ? 'home-heading' : `${view}-title`} className="view-title">
          {active?.label}
        </h1>
        <ViewBody view={view} session={session} onSession={onSession} navigate={navigate} />
      </main>
    </div>
  )
}
