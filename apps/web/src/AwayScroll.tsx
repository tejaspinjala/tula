import type { Session } from './passkeys'

/** Props of {@link AwayScroll}. */
export interface AwayScrollProps {
  session: Session
  /** Opens one Council session's votes in the Council panel. */
  onOpenCouncil: (sessionId: string) => void
}

/** The "While you were away" scroll. */
export function AwayScroll(_props: AwayScrollProps) {
  return null
}
