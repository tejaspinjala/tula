import type { Fetcher } from './artifacts'
import type { TalkAction, TalkState } from './game/interact'
import type { SceneQuest, SceneState } from './game/scene'
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

/** The dialog over the canvas: a Member's card with Quest actions, or the Seal desk. */
export function TalkDialog(_props: TalkDialogProps) {
  return null
}
