// privateEligible gate (SPEC 4.8, C13). The rule reads the owner-locked schema field on each provider:
// `privateEligible: true` is honoured only for (a) the claude-code adapter on a Claude Max subscription,
// (b) a provider whose baseUrl is loopback, or (c) a provider with a valid owner confirmation record.
// No provider names appear here. An Anthropic API key (auth 'api_key') is NOT Claude Max.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { append, canonicalJson, verify, type JsonValue } from '../lib/chain.ts';
import { read } from '../lib/store.ts';
import { resolveInside } from '../lib/paths.ts';
import { providersSchema, type Provider } from '../schema/providers.ts';

export const CONFIRMATIONS_FILE = 'approvals/private-provider-confirmations.jsonl';
export const AUDIT_FILE = 'audit/audit.jsonl';
export const PROVIDERS_FILE = 'org/providers.json';
const RECORD_KIND = 'private_provider_confirmation';

export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m[1] === '127' && [m[2], m[3], m[4]].every((o) => Number(o) <= 255);
}

/** True when the provider qualifies for private data without any owner confirmation. */
export function privateEligibleByDefault(p: Provider): boolean {
  if (p.adapter === 'claude-code') return p.auth === 'subscription' && (p.baseUrl === undefined || isLoopbackUrl(p.baseUrl));
  return isLoopbackUrl(p.baseUrl);
}

/** Binds a confirmation to what the provider actually is, so editing the endpoint voids it. */
export function providerFingerprint(p: Provider): string {
  const basis = { adapter: p.adapter, auth: p.auth ?? null, baseUrl: p.baseUrl ?? null, secretRef: p.secretRef ?? null };
  return createHash('sha256').update(canonicalJson(basis)).digest('hex');
}

/** A chain-valid owner confirmation for exactly this provider id + fingerprint exists. */
export function hasOwnerConfirmation(home: string, id: string, p: Provider): boolean {
  const file = resolveInside(home, CONFIRMATIONS_FILE);
  if (!fs.existsSync(file)) return false;
  if (!verify(file).ok) return false;
  const want = providerFingerprint(p);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const pl = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload;
      if (pl && pl.kind === RECORD_KIND && pl.providerId === id && pl.decidedBy === 'owner' && pl.fingerprint === want) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Returns one message per provider whose privateEligible flag is not allowed. Empty = ok. */
export function privateEligibleIssues(home: string, providers: Record<string, Provider>): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(providers)) {
    if (!p.privateEligible || privateEligibleByDefault(p)) continue;
    if (hasOwnerConfirmation(home, id, p)) continue;
    out.push(
      `provider '${id}' sets privateEligible but is neither a Claude Max subscription nor loopback and has no valid owner confirmation (run: owner.ts confirm-private-provider ${id})`,
    );
  }
  return out;
}

/** Owner action: records that the owner accepted breaking C13 for this provider. Used by the owner CLI only. */
export async function confirmPrivateProvider(id: string, opts: { home: string; now?: () => Date }): Promise<{ seq: number; hash: string }> {
  const cfg = await read(resolveInside(opts.home, PROVIDERS_FILE), providersSchema);
  const p = cfg.providers[id];
  if (!p) throw new Error(`no provider '${id}' in ${PROVIDERS_FILE}`);
  if (!p.privateEligible) throw new Error(`provider '${id}' does not set privateEligible; nothing to confirm`);
  if (privateEligibleByDefault(p)) throw new Error(`provider '${id}' is private-eligible by default; no confirmation needed`);
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const payload: JsonValue = {
    kind: RECORD_KIND,
    providerId: id,
    fingerprint: providerFingerprint(p),
    decidedBy: 'owner',
    decidedAt: at,
    note: 'owner accepted that this provider breaks C13 (private data pinned to Claude Max + loopback)',
  };
  const e = await append(resolveInside(opts.home, CONFIRMATIONS_FILE), payload);
  await append(resolveInside(opts.home, AUDIT_FILE), {
    actor: 'owner',
    action: 'private_provider.confirm',
    target: id,
    outcome: 'ok',
    reason: `confirmation seq ${e.seq}`,
  });
  return { seq: e.seq, hash: e.hash };
}
