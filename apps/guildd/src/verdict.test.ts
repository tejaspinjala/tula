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
  test('meta_draft: text that talks about doing the task instead of doing it fails', () => {
    for (const meta of [
      "I'm ready to work on this Quest and draft an announcement.",
      'I will draft the announcement now.',
      'As an AI language model, I cannot post.',
      'Sure! I can help you write that announcement.',
    ]) {
      expect(find(meta, 'meta_draft')?.passed).toBe(false)
    }
    expect(
      find('Guildhall 1.0 is live: Seals now bind every post to its Verdict.', 'meta_draft')?.passed
    ).toBe(true)
  })
  test('meta_draft: allowMetaDrafts turns the check off', () => {
    const policy = { ...DEFAULT_POLICY, allowMetaDrafts: true }
    expect(find('I will draft the announcement now.', 'meta_draft', policy)?.passed).toBe(true)
  })
})
