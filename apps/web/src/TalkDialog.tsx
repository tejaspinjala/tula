import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Fetcher } from './artifacts'
import { assignQuest, templatesFor } from './assign'
import type { TalkAction, TalkState } from './game/interact'
import type { SceneMember, SceneQuest, SceneState } from './game/scene'
import { hallTitle } from './game/walk'
import type { Session } from './passkeys'

/** What the dialog needs from the page. */
export interface TalkDialogProps {
  session: Session
  fetcher: Fetcher
  state: TalkState
  dispatch: (action: TalkAction) => void
  scene: SceneState | null
  quests: readonly (SceneQuest & { state?: string })[]
  navigate: (path: string) => void
}

const STATE_WORDS: Record<string, string> = {
  queued: 'queued',
  active: 'active',
  awaiting_seal: 'awaiting a Seal',
  done: 'done',
  dead: 'dead-lettered',
}

/**
 * The dialog over the canvas: a Member's card with Quest actions, or the Seal desk. A native modal
 * `<dialog>` (focus is trapped and Esc closes it by the platform). Every action goes through an
 * existing governed route or a ledger page; approving a Seal still asks for the passkey there.
 */
export function TalkDialog({
  session,
  fetcher,
  state,
  dispatch,
  scene,
  quests,
  navigate,
}: TalkDialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const open = state.open
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) {
      return
    }
    if (open !== null && !dialog.open) {
      dialog.showModal()
    } else if (open === null && dialog.open) {
      dialog.close()
    }
  }, [open])

  const member: SceneMember | undefined =
    open?.kind === 'member' ? scene?.members[open.id] : undefined
  const go = (path: string) => {
    dispatch({ type: 'close' })
    navigate(path)
  }

  return (
    <dialog
      ref={ref}
      className="talk-dialog"
      aria-labelledby={open ? 'talk-title' : undefined}
      onClose={() => dispatch({ type: 'close' })}
    >
      {member && scene && (
        <MemberCard
          key={member.id}
          session={session}
          fetcher={fetcher}
          member={member}
          scene={scene}
          quests={quests}
          form={state.form}
          dispatch={dispatch}
          go={go}
        />
      )}
      {open?.kind === 'sealDesk' && scene && (
        <>
          <h2 id="talk-title">Seal desk</h2>
          {scene.scrolls.length === 0 ? (
            <p>No Seals are waiting.</p>
          ) : (
            <>
              <p>
                {scene.scrolls.length} {scene.scrolls.length === 1 ? 'Seal is' : 'Seals are'}{' '}
                waiting for you.
              </p>
              <ul>
                {scene.scrolls.map((scroll) => (
                  <li key={scroll.questId}>{scroll.title}</li>
                ))}
              </ul>
            </>
          )}
          <div className="talk-actions">
            <button type="button" className="btn" onClick={() => go('/seals')}>
              Review Seal
            </button>
            <button type="button" onClick={() => dispatch({ type: 'close' })}>
              Close
            </button>
          </div>
          <p className="muted">Approving a Seal asks for your passkey in the Seal inbox.</p>
        </>
      )}
    </dialog>
  )
}

function MemberCard({
  session,
  fetcher,
  member,
  scene,
  quests,
  form,
  dispatch,
  go,
}: {
  session: Session
  fetcher: Fetcher
  member: SceneMember
  scene: SceneState
  quests: TalkDialogProps['quests']
  form: TalkState['form']
  dispatch: (action: TalkAction) => void
  go: (path: string) => void
}) {
  const room = scene.rooms.find((r) => r.hallId === member.hallId)
  const quest = member.questId === null ? undefined : quests.find((q) => q.id === member.questId)
  const status = quest?.state ? (STATE_WORDS[quest.state] ?? quest.state) : member.status
  return (
    <>
      <h2 id="talk-title">{member.name}</h2>
      <dl className="talk-facts">
        <dt>Rank</dt>
        <dd>{member.rank}</dd>
        <dt>Hall</dt>
        <dd>{room ? hallTitle(room.name) : 'No Hall'}</dd>
        <dt>Quest</dt>
        <dd>{quest ? `${quest.title} (${status})` : `No Quest right now (${member.status})`}</dd>
      </dl>
      {form === 'assign' ? (
        <AssignForm
          session={session}
          fetcher={fetcher}
          member={member}
          onBack={() => dispatch({ type: 'back' })}
          onBoard={() => go('/quests')}
        />
      ) : (
        <>
          <h3>Recent messages</h3>
          <p className="muted">No messages yet.</p>
          <div className="talk-actions">
            <button type="button" className="btn" onClick={() => dispatch({ type: 'assign' })}>
              Assign a Quest
            </button>
            <button type="button" onClick={() => go('/roster')}>
              Open in ledger
            </button>
            <button type="button" onClick={() => dispatch({ type: 'close' })}>
              Close
            </button>
          </div>
        </>
      )}
    </>
  )
}

function AssignForm({
  session,
  fetcher,
  member,
  onBack,
  onBoard,
}: {
  session: Session
  fetcher: Fetcher
  member: SceneMember
  onBack: () => void
  onBoard: () => void
}) {
  const templates = templatesFor(member.hallId)
  const [title, setTitle] = useState('')
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [posted, setPosted] = useState(false)
  // One key per opened form, so a retried submit cannot post the Quest twice.
  const [jobKey] = useState(() => `talk-${crypto.randomUUID()}`)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await assignQuest(session, fetcher, {
      templateId,
      title: title.trim(),
      ownerId: member.id,
      jobKey,
    })
    setBusy(false)
    if (result.ok) {
      setPosted(true)
    } else {
      setError(result.message)
    }
  }

  if (posted) {
    return (
      <>
        <p role="status">Quest posted to the Quest Board for {member.name}.</p>
        <div className="talk-actions">
          <button type="button" className="btn" onClick={onBoard}>
            Open Quest Board
          </button>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </>
    )
  }
  if (templates.length === 0) {
    return (
      <>
        <p>This Hall has no Quest templates yet.</p>
        <div className="talk-actions">
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </>
    )
  }
  return (
    <form onSubmit={submit}>
      <div className="talk-field">
        <label htmlFor="talk-template">Quest template</label>
        <select
          id="talk-template"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="talk-field">
        <label htmlFor="talk-quest-title">Quest title</label>
        <input
          id="talk-quest-title"
          type="text"
          required
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="talk-actions">
        <button type="submit" className="btn" disabled={busy || title.trim() === ''}>
          Post Quest
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  )
}
