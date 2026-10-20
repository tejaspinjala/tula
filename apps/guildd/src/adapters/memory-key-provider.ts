import { DerivedKeyProvider } from './derived-key-provider'

/**
 * Memory adapter for {@link KeyProvider}: the master secret lives in this process only. Pass the
 * same 32 bytes to a second instance to model a restart; with none, a fresh random master is used.
 */
export class MemoryKeyProvider extends DerivedKeyProvider {
  /** @param master 32 secret bytes; random when omitted. */
  constructor(master: Uint8Array = crypto.getRandomValues(new Uint8Array(32))) {
    super(master)
  }
}
