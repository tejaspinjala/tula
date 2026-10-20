import { describe, expect, test } from 'bun:test'
import { DEFAULT_POLICY, runChecks } from './verdict'

const find = (content: string, check: string, policy = DEFAULT_POLICY) =>
  runChecks(content, policy).find((f) => f.check === check)

describe('deterministic Verdict checks', () => {
  test('length: passes within the limit, fails when empty or over', () => {
    expect(find('hello', 'length')?.passed).toBe(true)
    expect(find('   ', 'length')?.passed).toBe(false)
    expect(find('x'.repeat(11), 'length', { ...DEFAULT_POLICY, maxLength: 10 })?.passed).toBe(false)
  })
  test('banned terms: case-insensitive match fails', () => {
    const policy = { ...DEFAULT_POLICY, bannedTerms: ['guaranteed returns'] }
    expect(find('We offer Guaranteed Returns', 'banned_terms', policy)?.passed).toBe(false)
    expect(find('We offer returns', 'banned_terms', policy)?.passed).toBe(true)
  })
  test('required terms: each must be present', () => {
    const policy = { ...DEFAULT_POLICY, requiredTerms: ['#ad'] }
    expect(find('buy now #AD', 'required_terms', policy)?.passed).toBe(true)
    expect(find('buy now', 'required_terms', policy)?.passed).toBe(false)
  })
  test('links: https to a public host passes; http, credentials, IPs and localhost fail', () => {
    expect(find('see https://example.com/a', 'links')?.passed).toBe(true)
    for (const bad of [
      'http://example.com',
      'https://user:pw@example.com',
      'https://10.0.0.1/x',
      'https://localhost/x',
      'javascript:alert(1)',
    ]) {
      expect(find(`go ${bad}`, 'links')?.passed).toBe(false)
    }
  })
  test('private data: emails, card numbers, keys and secret labels fail', () => {
    expect(find('a nice post', 'private_data')?.passed).toBe(true)
    for (const bad of [
      'mail me a@b.co',
      'card 4111 1111 1111 1111',
      '-----BEGIN PRIVATE KEY-----',
      'token sk-abcdefghijklmnopqrstuv',
      'password: hunter2',
      'ssn 123-45-6789',
    ]) {
      expect(find(bad, 'private_data')?.passed).toBe(false)
    }
  })
  test('findings never echo the matched content', () => {
    const f = find('password: hunter2', 'private_data')
    expect(JSON.stringify(f)).not.toContain('hunter2')
  })
})
