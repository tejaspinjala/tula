// Secret-material detection used by Connection refs, webhook HMAC refs and provider secretRef.
import { describe, expect, test } from 'bun:test';
import { containsSecretValue, ID_RE, looksLikeOpaqueToken, schemas, secretPathRef } from '../../../engine/schema/index.ts';

const SECRETS = [
  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
  'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  'ghp_0123456789abcdefghijABCDEFGHIJ',
  'xoxb-123456789012-abcdefghij',
  'AKIAIOSFODNN7EXAMPLE',
  'AIzaSyA1234567890abcdefghijklmnopqrstu',
  'ya29.a0AfH6SMBx3kLmN0pQrStUvWxYz123',
  '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'password=hunter22',
];
const REFS = ['providers/OPENROUTER_API_KEY', '/channels/youtube-main', 'OAUTH_CLIENT_SECRET', 'refresh_token', 'tula-fleet', 'laptop', '/hooks/LEARNING_HMAC_V2'];

describe('secret detection', () => {
  test.each(SECRETS)('detects %s', (s) => {
    expect(containsSecretValue(s) || looksLikeOpaqueToken(s)).toBe(true);
    expect(secretPathRef.safeParse(s).success).toBe(false);
  });

  test.each(REFS)('accepts reference %s', (s) => {
    expect(containsSecretValue(s)).toBe(false);
    expect(looksLikeOpaqueToken(s)).toBe(false);
  });

  test('a long random string in a ref field is rejected even without a known prefix', () => {
    expect(looksLikeOpaqueToken('Zx9QmT4vL2pR8sK1wN6yB3cH7')).toBe(true);
  });

  test('a connection never holds secret material anywhere (deep scan)', () => {
    const conn = {
      id: 'x-conn', teamId: 'team-a', connectorId: 'manual', connectorVersion: '0.1.0',
      account: { displayName: 'ghp_0123456789abcdefghijABCDEFGHIJ', owner: 'llc' },
      auth: { mode: 'manual' }, posting: { mode: 'manual', dailyLimit: 1 }, status: 'active',
    };
    const r = schemas.connection.safeParse(conn);
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.path)).toContainEqual(['account', 'displayName']);
  });
});

describe('ID_RE', () => {
  test('accepts <prefix>_<26 Crockford base32> and rejects look-alikes', () => {
    expect(ID_RE.test('task_01JAB3Z9X8K7M6N5P4Q3R2S1T0')).toBe(true);
    expect(ID_RE.test('01JAB3Z9X8K7M6N5P4Q3R2S1T0')).toBe(false); // bare ULID
    expect(ID_RE.test('task_01JAB3Z9X8K7M6N5P4Q3R2S1TI')).toBe(false); // I is not Crockford
    expect(ID_RE.test('Task_01JAB3Z9X8K7M6N5P4Q3R2S1T0')).toBe(false);
    expect(ID_RE.test('task_01JAB3Z9X8K7M6N5P4Q3R2S1T')).toBe(false); // 25 chars
  });
});
