/**
 * `bun run guild:enrol-link [--guild <id>]`: run on the host that holds the database. Prints a
 * one-time link that enrols a passkey on a new device (no live session needed). It reads the
 * same environment as `start:selfhost`, so `PUBLIC_ORIGIN` gives the link's origin; shell access
 * to the host is the trust root, so this adds no new trust.
 */
import { resolve } from 'node:path'
import { selfhostPlan } from './start-selfhost'

async function main() {
  const root = resolve(import.meta.dir, '..')
  const plan = selfhostPlan(process.env, root)
  const proc = Bun.spawn(['bun', 'apps/guildd/src/enrol-link-cli.ts', ...process.argv.slice(2)], {
    cwd: root,
    env: plan.guildd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await proc.exited)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'guild:enrol-link failed'}\n`)
  process.exit(1)
})
