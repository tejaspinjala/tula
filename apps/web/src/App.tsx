import { useEffect, useState } from 'react'
import { ArchivePanel } from './ArchivePanel'
import { ArtifactViewer } from './ArtifactViewer'
import { CostTablePanel } from './CostTablePanel'
import { FoundGuildPanel } from './FoundGuildPanel'
import { GatesPanel } from './GatesPanel'
import { LearningPanel } from './LearningPanel'
import { PasskeyPanel } from './PasskeyPanel'
import { ProposalPanel } from './ProposalPanel'
import {
  fetchGuild,
  foundingOpen,
  type PasskeyBrowser,
  type Session,
  webAuthnBrowser,
} from './passkeys'
import { QuestBoardPanel } from './QuestBoardPanel'
import { RosterPanel } from './RosterPanel'
import { SealPanel } from './SealPanel'
import { SignInPanel } from './SignInPanel'
import { SummonPanel } from './SummonPanel'
import { TimelinePanel } from './TimelinePanel'
import { TreasuryPanel } from './TreasuryPanel'
import { TripwirePanel } from './TripwirePanel'
import { VaultPanel } from './VaultPanel'

/** Ledger-view shell: keyboard-navigable, with a skip link, landmarks and passkey sign-in. */
export function App({ browser = webAuthnBrowser }: { browser?: PasskeyBrowser } = {}) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')
  const [session, setSession] = useState<Session | null>(null)

  const [open, setOpen] = useState(false)
  const [guild, setGuild] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
    foundingOpen(fetch).then(setOpen)
  }, [])

  useEffect(() => {
    setGuild(null)
    if (session) {
      fetchGuild(session, fetch)
        .then(setGuild)
        .catch(() => setGuild({ id: session.guildId, name: '' }))
    }
  }, [session])

  if (!session) {
    return (
      <>
        <a href="#main" className="absolute -translate-y-full bg-white p-2 focus:translate-y-0">
          Skip to content
        </a>
        <header className="mx-auto max-w-3xl px-8 pt-8">
          <h1 className="text-2xl font-semibold">Guildhall ledger</h1>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-3xl p-8">
          <p>guildd: {status}</p>
          <SignInPanel fetcher={fetch} browser={browser} onSession={setSession} />
          {open && <FoundGuildPanel fetcher={fetch} browser={browser} onSession={setSession} />}
        </main>
      </>
    )
  }

  return (
    <>
      <a href="#main" className="absolute -translate-y-full bg-white p-2 focus:translate-y-0">
        Skip to content
      </a>
      <header className="mx-auto max-w-3xl px-8 pt-8">
        <h1 className="text-2xl font-semibold">Guildhall ledger</h1>
        <p aria-live="polite">
          {guild?.name ? `${guild.name} ` : ''}
          <span className="font-mono">{session.guildId}</span>
        </p>
        <nav aria-label="Ledger" className="mt-2 flex gap-4">
          <a href="#passkey-heading">Passkey</a>
          <a href="#artifact-heading">Artifacts</a>
          <a href="#vault-heading">Vault</a>
          <a href="#roster-heading">Roster</a>
          <a href="#archive-heading">Archive</a>
          <a href="#learning-heading">Learnings</a>
          <a href="#proposals-heading">Proposals</a>
          <a href="#seals-heading">Seals</a>
          <a href="#quests-heading">Quest Board</a>
          <a href="#treasury-heading">Treasury</a>
          <a href="#costs-heading">Costs</a>
          <a href="#timeline-heading">Timeline</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl p-8">
        <p>guildd: {status}</p>
        <PasskeyPanel session={session} onSession={setSession} />
        <ArtifactViewer session={session} />
        <VaultPanel session={session} />
        <RosterPanel session={session} />
        <ArchivePanel session={session} />
        <LearningPanel session={session} />
        <ProposalPanel session={session} />
        <SealPanel session={session} />
        <SummonPanel session={session} />
        <GatesPanel session={session} />
        <TripwirePanel session={session} />
        <TreasuryPanel session={session} />
        <QuestBoardPanel session={session} />
        <CostTablePanel session={session} />
        <TimelinePanel session={session} />
      </main>
    </>
  )
}
