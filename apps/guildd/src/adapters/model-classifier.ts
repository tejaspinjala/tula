import { type Classification, type Classifier, classification } from '../ports/classifier'

/**
 * The cheap-model seam. The composition root supplies an implementation bound to whichever model
 * the guild's `cheap` routing profile names; engine code never names a model id. Not wired to any
 * real model yet.
 */
export interface ClassifierModel {
  /** Returns the model's raw text answer to `prompt`; should honour `signal`. */
  complete(prompt: string, signal: AbortSignal): Promise<string>
}

/** Default bound on one classification call. */
export const CLASSIFIER_TIMEOUT_MS = 5_000

/**
 * {@link Classifier} that asks a cheap model for structured JSON and validates it with Zod.
 * Bounded by a timeout; any failure (timeout, bad JSON, schema mismatch) throws, and routing falls
 * back deterministically.
 */
export class ModelClassifier implements Classifier {
  constructor(
    private readonly model: ClassifierModel,
    private readonly timeoutMs: number = CLASSIFIER_TIMEOUT_MS
  ) {}

  async classify(input: Parameters<Classifier['classify']>[0]): Promise<Classification> {
    const halls = input.halls.map((h) => h.id).join(', ')
    const prompt = `Classify the goal. Answer JSON {"hallId","rank","dataClass"}. hallId one of [${halls}]; rank apprentice|journeyman|adept; dataClass public|internal|private.\nGoal: ${input.goal}`
    const signal = AbortSignal.timeout(this.timeoutMs)
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('classifier timed out')), {
        once: true,
      })
    })
    const raw = await Promise.race([this.model.complete(prompt, signal), aborted])
    return classification.parse(JSON.parse(raw))
  }
}
