import { describe, expect, test } from 'bun:test'
import { clientAddress } from './client-ip'

describe('clientAddress', () => {
  test('uses the socket address and ignores X-Forwarded-For when the proxy is not trusted', () => {
    const forwardedFor = '198.51.100.1'
    expect(clientAddress({ socket: '203.0.113.9', forwardedFor, trustProxy: false })).toBe(
      '203.0.113.9'
    )
  })

  test('behind a trusted proxy uses the last forwarded hop, which the proxy appended', () => {
    const forwardedFor = '6.6.6.6, 198.51.100.1'
    expect(clientAddress({ socket: '10.0.0.2', forwardedFor, trustProxy: true })).toBe(
      '198.51.100.1'
    )
  })

  test('a trusted proxy with no header falls back to the socket address', () => {
    expect(clientAddress({ socket: '10.0.0.2', forwardedFor: undefined, trustProxy: true })).toBe(
      '10.0.0.2'
    )
  })

  test('with no address at all every caller shares one strict bucket', () => {
    expect(clientAddress({ socket: undefined, forwardedFor: undefined, trustProxy: false })).toBe(
      'unknown'
    )
  })
})
