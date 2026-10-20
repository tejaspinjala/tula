import type { Fetcher } from '../artifacts'
import type { PasskeyBrowser, Session } from '../passkeys'

/** Props of {@link WorkflowPanel}. */
export interface WorkflowPanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Forces the desktop editor (true) or the phone's read-only view (false); default follows the screen width. */
  desktop?: boolean
  /** Wait before the draft is sent to the validate route, in ms. */
  validateDelayMs?: number
  /** Whether to follow the live event stream (off in tests). */
  live?: boolean
}

/** The Workflows view: a drag-and-drop canvas to design, save, run and watch Workflows. */
export function WorkflowPanel(_props: WorkflowPanelProps) {
  return null
}
