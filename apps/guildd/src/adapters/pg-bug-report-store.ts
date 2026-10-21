import type { Db } from '../db/client'
import type {
  BugReport,
  BugReportPage,
  BugReportQuery,
  BugReportStore,
  FileBugReportResult,
  NewBugReport,
} from '../ports/bug-report-store'
import type { KeyProvider } from '../ports/key-provider'
import type { PgQuestQueue } from './pg-quest-queue'

/** Postgres {@link BugReportStore} (stub). */
export class PgBugReportStore implements BugReportStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly quests: PgQuestQueue
  ) {}

  async file(_guildId: string, _input: NewBugReport): Promise<FileBugReportResult> {
    throw new Error(`not implemented ${typeof this.db}${typeof this.keys}${typeof this.quests}`)
  }
  async countForQuest(_guildId: string, _questId: string): Promise<number> {
    throw new Error('not implemented')
  }
  async get(_guildId: string, _id: string): Promise<BugReport | null> {
    throw new Error('not implemented')
  }
  async forFixQuest(_guildId: string, _questId: string): Promise<BugReport | null> {
    throw new Error('not implemented')
  }
  async list(_guildId: string, _query: BugReportQuery): Promise<BugReportPage> {
    throw new Error('not implemented')
  }
}
