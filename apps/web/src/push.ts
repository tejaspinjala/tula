import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** The slice of the browser's push manager the ledger uses. */
export interface PushManagerLike {
  subscribe(options: {
    userVisibleOnly: boolean
    applicationServerKey: Uint8Array
  }): Promise<{ toJSON(): unknown }>
}

/** Asks the Guild Master for notification permission, subscribes this device and registers it. */
export async function enablePush(
  _session: Session,
  _env: { fetcher: Fetcher; push: PushManagerLike; permission: () => Promise<string> }
): Promise<'enabled' | 'denied' | 'unavailable'> {
  return 'unavailable'
}
