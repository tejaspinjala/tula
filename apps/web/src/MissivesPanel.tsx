import type { Session } from './passkeys'

/** The Hall's Missives in the Guild Hall view (stub). */
export function MissivesPanel({ session }: { session: Session | null }) {
  return <section aria-label="stub">{session ? '' : ''}</section>
}
