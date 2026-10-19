#!/usr/bin/env bun
// PostToolUse / PostToolUseFailure: settles the approval reservation security-gate.ts made at PreToolUse.
// Success -> consume (single use spent). Failure -> release (the approval stays usable, so a failed call
// does not burn it). If this hook never runs (crash, permission prompt rejected), the reservation's lease
// lapses (10 min) and the approval returns to 'approved' on its own.
import { readStdin } from '../lib/core.ts';
import type { HookEvent } from '../lib/core.ts';
import { actionHash, consume, findReservation, release, type ApprovalOptions } from '../lib/approvals.ts';
import { isExternal } from './security-gate.ts';

export type Outcome = 'success' | 'failure';

/** PostToolUseFailure is a failure; so is a PostToolUse whose response reports an error, interrupt or non-zero exit. */
export function outcomeOf(ev: HookEvent): Outcome {
  if (ev.hook_event_name === 'PostToolUseFailure') return 'failure';
  const r = ev.tool_response;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const o = r as Record<string, unknown>;
    if (o.is_error === true || o.isError === true || o.interrupted === true) return 'failure';
    for (const k of ['exitCode', 'exit_code', 'returnCode']) {
      if (typeof o[k] === 'number' && o[k] !== 0) return 'failure';
    }
  }
  return 'success';
}

export interface SettleResult {
  action: 'consumed' | 'released' | 'none';
  approvalId?: string;
}

export async function settle(ev: HookEvent, opts: ApprovalOptions = {}): Promise<SettleResult> {
  const tool = ev.tool_name || '';
  const input = ev.tool_input || {};
  if (!isExternal(tool, input)) return { action: 'none' };
  const hash = actionHash(tool, input);
  const res = await findReservation(ev.tool_use_id ? { toolUseId: ev.tool_use_id, actionHash: hash } : { actionHash: hash }, opts);
  if (!res || res.actionHash !== hash) return { action: 'none' };
  if (outcomeOf(ev) === 'success') {
    return (await consume(res.token, opts)) ? { action: 'consumed', approvalId: res.approvalId } : { action: 'none' };
  }
  const why = typeof ev.error === 'string' ? ev.error.slice(0, 200) : 'tool call failed';
  return (await release(res.token, why, opts)) ? { action: 'released', approvalId: res.approvalId } : { action: 'none' };
}

if (import.meta.main) {
  try {
    await settle(readStdin());
  } catch (e) {
    // Never block the session; an unsettled reservation lapses back to 'approved' after its lease.
    process.stderr.write(`post-approval: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
