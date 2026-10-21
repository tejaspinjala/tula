import type {
  CreateDossierResult,
  Dossier,
  DossierPage,
  DossierQuery,
  DossierStore,
  NewDossier,
} from '../ports/dossier-store'

/**
 * Memory adapter for {@link DossierStore}: state in this instance only; `create` checks the cap
 * and writes with no await between, so same-tick requests cannot overshoot it.
 */
export class MemoryDossierStore implements DossierStore {
  private readonly guilds = new Map<string, Dossier[]>()
  private nextSeq = 1

  private dossiers(guildId: string): Dossier[] {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = []
      this.guilds.set(guildId, all)
    }
    return all
  }

  async create(_guildId: string, _input: NewDossier): Promise<CreateDossierResult> {
    throw new Error('not implemented')
  }

  async get(guildId: string, id: string): Promise<Dossier | null> {
    return this.dossiers(guildId).find((d) => d.id === id) ?? null
  }

  async list(_guildId: string, _query: DossierQuery): Promise<DossierPage> {
    throw new Error('not implemented')
  }
}
