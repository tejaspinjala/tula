import type { Fetcher } from './artifacts'
import type { PasskeyBrowser, Session } from './passkeys'

/** Stub: the Found your guild screen (not yet implemented). */
export function FoundGuildPanel(_props: {
  fetcher: Fetcher
  browser: PasskeyBrowser
  onSession: (session: Session | null) => void
}) {
  return null
}
