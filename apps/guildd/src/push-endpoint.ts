/** Hosts of the known push services; `*.` matches any subdomain. Production uses exactly this list. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  '*.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
]

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const NUMERIC_HOST = /^[\d.x]+$/i

/**
 * Whether `endpoint` may be fetched as a push endpoint: https on the default port, no
 * credentials, a DNS name (never an IP literal, localhost or a single-label name) that matches
 * `allowed`. This is what keeps the server from being aimed at internal addresses (SSRF).
 */
export function isPushEndpoint(endpoint: string, allowed: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    host.includes(':') ||
    host.startsWith('[') ||
    IPV4.test(host) ||
    NUMERIC_HOST.test(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    !host.includes('.')
  ) {
    return false
  }
  return allowed.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
  )
}
