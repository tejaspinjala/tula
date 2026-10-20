/** Stub: filled in by the next commit. */
export function selfhostPlan(
  _source: Record<string, string | undefined>,
  _root: string
): {
  databaseHost: { host: string; port: number }
  guildd: Record<string, string | undefined> & {
    WEB_DIST: string
    WEBAUTHN_ORIGIN: string
    WEBAUTHN_RP_ID: string
    APP_DATABASE_URL: string
  }
} {
  throw new Error('not implemented')
}

/** Stub: filled in by the next commit. */
export async function isReachable(_host: string, _port: number, _deadlineMs: number) {
  return false
}
