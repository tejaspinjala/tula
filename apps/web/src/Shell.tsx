import type { MouseEvent } from 'react'
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
  const active = VIEWS.find((v) => v.id === view)
  const go = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return
    }
    event.preventDefault()
    navigate(path)
  }
  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="shell-header">
        <p className="brand">{guildName || 'Guildhall ledger'}</p>
        <p className="muted" aria-live="polite">
          Signed in <span className="mono">{session.guildId}</span>
          <span className="sep" aria-hidden="true">
            {' '}
            |{' '}
          </span>
          guildd: {status}
        </p>
      </header>
      <nav aria-label="Ledger" className="shell-nav">
        <ul>
          {VIEWS.map((v) => (
            <li key={v.id}>
              <a
                href={v.path}
                aria-current={v.id === view ? 'page' : undefined}
                onClick={go(v.path)}
              >
                {v.label}
              </a>
            </li>
          ))}
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
