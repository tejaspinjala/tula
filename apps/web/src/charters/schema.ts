import { z } from 'zod'
import { riteGraph } from '../../../guildd/src/rites/graph'
import { builderConfigSchema } from '../builder/model'

/** The largest Charter file the client reads, matching the server's 256 KB cap. */
export const CHARTER_MAX_BYTES = 256 * 1024

/** Raw file text beyond this is refused unread; the cap itself is measured on the compact form. */
const RAW_MAX_BYTES = 4 * CHARTER_MAX_BYTES

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
export function parseCharter(text: string): Charter {
  const tooLarge = new CharterFileError('The file is too large for a Charter (256 KB at most).')
  if (new TextEncoder().encode(text).length > RAW_MAX_BYTES) {
    throw tooLarge
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CharterFileError('The file is not valid JSON.')
  }
  if (new TextEncoder().encode(JSON.stringify(json)).length > CHARTER_MAX_BYTES) {
    throw tooLarge
  }
  const parsed = charterSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.join('.') || 'document'
    throw new CharterFileError(`The file is not a Charter this version reads (${where}).`)
  }
  return parsed.data
}
