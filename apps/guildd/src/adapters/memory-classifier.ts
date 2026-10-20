import { type Classification, type Classifier, classification } from '../ports/classifier'

/**
 * Deterministic {@link Classifier} for tests and local runs: answers a fixed classification, or,
 * with none, the first Hall at the lowest rank as `private` (fail closed). Calls no model.
 */
export class MemoryClassifier implements Classifier {
  constructor(private readonly fixed?: Classification) {}

  async classify(input: Parameters<Classifier['classify']>[0]): Promise<Classification> {
    if (this.fixed) {
      return classification.parse(this.fixed)
    }
    const first = input.halls[0]
    if (!first) {
      throw new Error('no Halls to classify into')
    }
    return { hallId: first.id, rank: 'apprentice', dataClass: 'private' }
  }
}
