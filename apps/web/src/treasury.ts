import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** The Treasury as the Treasury screen shows it. */
export interface TreasuryView {
  overview: {
    mode: 'paper'
    balances: { operating: number; reserve: number; profit: number }
    spentTodayCents: number
    day: string
    limits: { dailyCapCents: number; treasurerLimitCents: number }
  }
  entries: EntryView[]
  chain: { intact: true; entries: number } | { intact: false; firstBadSeq: number; reason: string }
}

/** One ledger entry. */
export interface EntryView {
  seq: number
  kind: string
  bucket: string
  amountCents: number
}

/** Integer cents as dollars. */
export function formatCents(_cents: number): string {
  return ''
}

/** Loads the overview, every ledger entry (following page cursors) and the hash-chain check. */
export async function loadTreasury(
  _session: Session,
  _fetcher: Fetcher,
  _options: { limit?: number } = {}
): Promise<TreasuryView> {
  throw new Error('not implemented')
}

/** One line for a ledger entry. */
export function describeEntry(_entry: EntryView): string {
  return ''
}
