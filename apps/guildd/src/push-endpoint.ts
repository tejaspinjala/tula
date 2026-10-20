/** Hosts of the known push services; `*.` matches any subdomain. Production uses exactly this list. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  '*.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
]

/**
 * Whether `endpoint` may be fetched as a push endpoint: https on the default port, no
 * credentials, a DNS name (never an IP literal, localhost or a single-label name) that matches
 * `allowed`. This is what keeps the server from being aimed at internal addresses (SSRF).
 */
export function isPushEndpoint(_endpoint: string, _allowed: readonly string[]): boolean {
  return false
}
