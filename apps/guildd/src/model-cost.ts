import type { ModelUsage } from './ports/model-provider'

/** Token prices in millionths of a dollar per million tokens; from the routing profile in guild config. */
export interface TokenPrice {
  inputMicrosPerMTok: number
  outputMicrosPerMTok: number
}

/** One cent in millionths of a dollar, the unit the ledger meters dollars in. */
export const MICROS_PER_CENT = 10_000

/** The cost of a call in millionths of a dollar, rounded up so metering never under-counts. */
export function costMicros(usage: ModelUsage, price: TokenPrice): number {
  return Math.ceil(
    (usage.inputTokens * price.inputMicrosPerMTok +
      usage.outputTokens * price.outputMicrosPerMTok) /
      1_000_000
  )
}
