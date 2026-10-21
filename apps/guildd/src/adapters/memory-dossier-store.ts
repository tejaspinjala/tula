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

  async create(guildId: string, input: NewDossier): Promise<CreateDossierResult> {
    const all = this.dossiers(guildId)
    const { requester } = input
    if (
      requester.kind === 'member' &&
      input.maxPerQuest !== undefined &&
      all.filter((d) => d.requester.kind === 'member' && d.requester.questId === requester.questId)
        .length >= input.maxPerQuest
    ) {
      return { ok: false, error: 'dossier_cap' }
    }
    const dossier: Dossier = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      subjectQuestId: input.subjectQuestId,
      subjectHallId: input.subjectHallId,
      requester,
      body: input.body,
      hash: input.hash,
      verified: input.verified,
      failedChecks: [...input.failedChecks],
      createdAt: input.at.toISOString(),
    }
    all.push(dossier)
    return { ok: true, dossier }
  }

  async get(guildId: string, id: string): Promise<Dossier | null> {
    return this.dossiers(guildId).find((d) => d.id === id) ?? null
  }

  async list(guildId: string, query: DossierQuery): Promise<DossierPage> {
    const visible = this.dossiers(guildId)
      .filter(
        (d) =>
          (d.subjectHallId === query.hallId ||
            (d.requester.kind === 'member' && d.requester.hallId === query.hallId)) &&
          (query.after === undefined || d.seq < query.after)
      )
      .sort((a, b) => b.seq - a.seq)
    const page = visible.slice(0, query.limit)
    const last = page.at(-1)
    return { dossiers: page, next: visible.length > page.length && last ? last.seq : null }
  }
}
