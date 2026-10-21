import type { CouncilCall, CouncilReply } from '../model-gateway'

/** What a scripted voice answers: a reply, or a thrown error. */
export type CouncilScript = (call: CouncilCall) => CouncilReply | Promise<CouncilReply>

/** A reply with usage, as the gateway returns it. */
export function reply(text: string): CouncilReply {
  return { text, usage: { inputTokens: 10, outputTokens: 5 }, costMicros: 15 }
}

/** A valid vote reply as JSON text. */
export function voteReply(vote: 'approve' | 'block' | 'abstain', ...reasons: string[]) {
  return reply(JSON.stringify({ vote, reasons }))
}

/**
 * A scripted stand-in for the model gateway's Council call: answers from `script`, records every
 * call it receives. State lives in this instance only.
 */
export class ScriptedCouncilModel {
  /** Every call received, in order. */
  readonly calls: CouncilCall[] = []

  constructor(private readonly script: CouncilScript) {}

  async councilComplete(_guildId: string, call: CouncilCall): Promise<CouncilReply> {
    this.calls.push(call)
    return this.script(call)
  }
}
