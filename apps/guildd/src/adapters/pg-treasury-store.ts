import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type { TreasuryStore } from '../ports/treasury-store'
import { TreasuryCore, type TreasuryTx } from '../treasury-core'

/** Postgres {@link TreasuryStore}. */
export class PgTreasuryStore extends TreasuryCore implements TreasuryStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    clock: Clock
  ) {
    super(clock)
  }

  protected run<T>(
    _guildId: string,
    _mode: 'read' | 'write',
    _fn: (tx: TreasuryTx) => Promise<T>
  ): Promise<T> {
    void this.db
    void this.keys
    return Promise.reject(new Error('not implemented'))
  }
}
