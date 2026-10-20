import { describe, expect, test } from 'bun:test'
import { isPushEndpoint, PUSH_SERVICE_HOSTS } from './push-endpoint'

describe('isPushEndpoint', () => {
  test('accepts https endpoints on the known push services', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) {
      expect(isPushEndpoint(url, PUSH_SERVICE_HOSTS)).toBe(true)
    }
  })

  test('rejects internal addresses, IP literals, plain http and unknown hosts', () => {
    for (const url of [
      'https://169.254.169.254/x',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://[::1]/',
      'https://evil.example/',
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://push.services.mozilla.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'not a url',
      'https://fcm.googleapis.com./x',
      'https://fcm.googleapis.com@evil.com/x',
      'https://xpush.apple.com/x',
      'https://evilpush.apple.com.attacker.net/x',
      'https://web.push.apple.com.attacker.net/x',
    ]) {
      expect(isPushEndpoint(url, PUSH_SERVICE_HOSTS)).toBe(false)
    }
  })

  test('a test allow-list still never admits IP literals or localhost', () => {
    expect(isPushEndpoint('https://push.example/a', ['push.example'])).toBe(true)
    expect(isPushEndpoint('https://127.0.0.1/', ['127.0.0.1'])).toBe(false)
    expect(isPushEndpoint('https://localhost/', ['localhost'])).toBe(false)
  })
})
