import { bindClassifier } from '../classifier-binding'
import type { Classification, Classifier } from '../ports/classifier'
import type { ConfigStore } from '../ports/config-store'
import { ModelClassifier } from './model-classifier'

/** Collaborators of {@link BoundClassifier}. */
export interface BoundClassifierDeps {
  config: Pick<ConfigStore, 'current'>
  /** The gateway's classifier call: it refuses a provider that is not private-eligible. */
  gateway: {
    classifierComplete(
      guildId: string,
      call: { decisionKey: string; hallId: string; prompt: string }
    ): Promise<string>
  }
  /** Answers when no private-eligible provider is bound; calls no model. */
  standin: Classifier
}

/**
 * {@link Classifier} that follows the guild's config (ADR-0006, ADR-0012): the model classifier on
 * a private-eligible provider's cheap tier when one exists, else the stand-in. The binding is
 * re-read on every call, so nothing is kept in process memory and turning the flag off unbinds at
 * once. The model's claim stays advisory; routing logs it and never lowers a class from it.
 */
export class BoundClassifier implements Classifier {
  constructor(private readonly deps: BoundClassifierDeps) {}

  async classify(input: Parameters<Classifier['classify']>[0]): Promise<Classification> {
    const { config } = await this.deps.config.current(input.guildId)
    if (bindClassifier(config).kind === 'standin') {
      return this.deps.standin.classify(input)
    }
    const hallId = input.halls[0]?.id
    if (!hallId) {
      throw new Error('no Halls to classify into')
    }
    const model = new ModelClassifier(
      {
        complete: (prompt) =>
          this.deps.gateway.classifierComplete(input.guildId, {
            decisionKey: input.decisionKey,
            hallId,
            prompt,
          }),
      },
      config
    )
    return model.classify(input)
  }
}
