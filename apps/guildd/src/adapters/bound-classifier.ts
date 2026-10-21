import type { Classifier } from '../ports/classifier'
import type { ConfigStore } from '../ports/config-store'

/** Collaborators of {@link BoundClassifier}. */
export interface BoundClassifierDeps {
  config: Pick<ConfigStore, 'current'>
  gateway: {
    classifierComplete(
      guildId: string,
      call: { decisionKey: string; hallId: string; prompt: string; signal?: AbortSignal }
    ): Promise<string>
  }
  standin: Classifier
}

/** Stub. */
export class BoundClassifier implements Classifier {
  constructor(private readonly deps: BoundClassifierDeps) {}

  async classify(): Promise<never> {
    void this.deps
    throw new Error('not implemented')
  }
}
