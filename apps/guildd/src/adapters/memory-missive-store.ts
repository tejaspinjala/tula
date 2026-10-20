import type {
  MissivePage,
  MissiveQuery,
  MissiveStore,
  NewMissive,
  SendResult,
} from '../ports/missive-store'

/** Memory adapter for {@link MissiveStore}: state in this instance only. */
export class MemoryMissiveStore implements MissiveStore {
  async send(_guildId: string, _input: NewMissive): Promise<SendResult> {
    throw new Error('not implemented')
  }

  async list(_guildId: string, _query: MissiveQuery): Promise<MissivePage> {
    throw new Error('not implemented')
  }
}
