import { compose } from './composition'
import { enrolLink, parseEnrolArgs } from './enrol-link'
import { loadWebauthnEnv } from './env'

/**
 * `bun run guild:enrol-link [--guild <id>]` (run on the host): prints a one-time link that
 * enrols a passkey on a new device. The token is printed once, on stdout, and never logged.
 */
try {
  const args = parseEnrolArgs(process.argv.slice(2))
  const { adapters } = await compose()
  try {
    const link = await enrolLink({
      identity: adapters.identity,
      origin: loadWebauthnEnv().WEBAUTHN_ORIGIN,
      guildIds: (after, limit) => adapters.db.guildIds(after, limit),
      args,
    })
    process.stdout.write(
      `Open this link on the new device within 15 minutes. It works once.\n\n${link.url}\n`
    )
  } finally {
    await adapters.db.close()
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'guild:enrol-link failed'}\n`)
  process.exit(1)
}
