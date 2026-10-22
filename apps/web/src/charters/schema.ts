import { z } from 'zod'
import { riteGraph } from '../../../guildd/src/rites/graph'
import { builderConfigSchema } from '../builder/model'

/** The largest Charter file the client reads, matching the server's 256 KB cap. */
export const CHARTER_MAX_BYTES = 256 * 1024

/** What an export left out of the file, and why. */
export const omittedEntry = z.object({ kind: z.string(), id: z.string(), reason: z.string() })

/** The Charter document (#180): structure only, no ids, versions or ledger data. */
export const charterSchema = z.object({
  charter: z.literal(1),
  name: z.string(),
  exportedAt: z.string(),
  config: builderConfigSchema,
  rites: z.array(z.object({ name: z.string(), graph: riteGraph })).max(50),
  omitted: z.array(omittedEntry),
})

/** A parsed Charter. */
export type Charter = z.infer<typeof charterSchema>

/** Thrown when a picked file is not a usable Charter; `message` is the reason shown. */
export class CharterFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharterFileError'
  }
}

/** Parses the text of a `.charter.json` file, or throws {@link CharterFileError}. */
export function parseCharter(_text: string): Charter {
  throw new CharterFileError('not implemented')
}
