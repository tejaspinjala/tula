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

  test('IPv6 addresses are keyed by their /64, so one prefix is one client', () => {
    const key = (socket: string) =>
      clientAddress({ socket, forwardedFor: undefined, trustProxy: false })
    expect(key('2001:db8:1:2:aaaa::1')).toBe(key('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'))
    expect(key('2001:db8:1:3::1')).not.toBe(key('2001:db8:1:2::1'))
    expect(key('2001:db8:1:2::1')).toContain('/64')
  })

  test('an IPv4-mapped IPv6 address is keyed as the IPv4 address', () => {
    expect(
      clientAddress({ socket: '::ffff:203.0.113.9', forwardedFor: undefined, trustProxy: false })
    ).toBe('203.0.113.9')
  })

  test('a hex IPv4-mapped IPv6 address is keyed as the dotted IPv4 address', () => {
    expect(
      clientAddress({ socket: '::ffff:7f00:1', forwardedFor: undefined, trustProxy: false })
    ).toBe('127.0.0.1')
  })

  test('an IPv6 address with an embedded dotted quad expands correctly to its /64', () => {
    const key = (socket: string) =>
      clientAddress({ socket, forwardedFor: undefined, trustProxy: false })
    expect(key('1:2:3:4:5:6:1.2.3.4')).toBe(key('1:2:3:4::9'))
    expect(key('1:2:3:4:5:6:1.2.3.4')).not.toBe(key('1:2:3:5::9'))
  })

  test('something that looks like IPv6 but cannot be expanded shares one fallback bucket', () => {
    const key = (socket: string) =>
      clientAddress({ socket, forwardedFor: undefined, trustProxy: false })
    expect(key('1:2:3:4:5:6:7:8:9')).toBe(key('zz::::garbage:'))
    expect(key('1:2:3:4:5:6:7:8:9')).not.toContain('garbage')
  })

  test('with no address at all every caller shares one strict bucket', () => {
    expect(clientAddress({ socket: undefined, forwardedFor: undefined, trustProxy: false })).toBe(
      'unknown'
    )
  })
})
