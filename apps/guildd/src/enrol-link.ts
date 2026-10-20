import { z } from 'zod'
import type { IdentityProvider } from './ports/identity'

/** The options `guild:enrol-link` accepts. */
export interface EnrolArgs {
  /** The guild to mint a link for; optional when the host has exactly one guild. */
  guild?: string
}

/**
 * Parses the command line: `--guild <uuid>` or nothing. Anything else throws, so a typo never
 * mints a link for a guild the operator did not name.
 */
export function parseEnrolArgs(argv: string[]): EnrolArgs {
  if (argv.length === 0) {
    return {}
  }
  const [flag, value, ...rest] = argv
  const guild = z.uuid().safeParse(value)
  if (flag !== '--guild' || !guild.success || rest.length > 0) {
    throw new Error('usage: bun run guild:enrol-link [--guild <guild id>]')
  }
  return { guild: guild.data }
}

const PAGE = 100

async function allGuildIds(
  guildIds: (after: string | undefined, limit: number) => Promise<string[]>
): Promise<string[]> {
  const all: string[] = []
  let after: string | undefined
  for (;;) {
    const page = await guildIds(after, PAGE)
    all.push(...page)
    const last = page[page.length - 1]
    if (page.length < PAGE || last === undefined) {
      return all
    }
    after = last
  }
}

const NONE = 'no guild exists on this host yet: found one in the web app first'

/**
 * Mints a one-time enrolment link for the Guild Master of one guild. The token rides in the URL
 * fragment, which a browser never sends to a server or writes to a log. Run on the host, where
 * shell access to the database is already the trust root. This function logs nothing.
 */
export async function enrolLink(input: {
  identity: IdentityProvider
  /** The public origin the Guild Master opens (the WebAuthn origin). */
  origin: string
  guildIds: (after: string | undefined, limit: number) => Promise<string[]>
  args: EnrolArgs
}): Promise<{ url: string; guildId: string; expiresAt: Date }> {
  const ids = await allGuildIds(input.guildIds)
  const wanted = input.args.guild
  if (!wanted && ids.length > 1) {
    throw new Error('this host has several guilds: pass --guild <guild id>')
  }
  const guildId = wanted ? ids.find((id) => id === wanted) : ids[0]
  if (!guildId) {
    throw new Error(wanted ? 'no such guild on this host' : NONE)
  }
  const { token, expiresAt } = await input.identity.issueEnrolmentToken(guildId)
  const url = new URL(input.origin)
  url.hash = `enrol=${token}`
  return { url: url.toString(), guildId, expiresAt }
}
