import { expect, test } from 'bun:test'
import { withClusterDdlLock, withScratchSchema } from './test-db'

/** How long other workers hold the cluster DDL lock in this reproduction (longer than Bun's 5s default). */
const HELD_MS = 6_000

// Reproduction for #126: under concurrent load a DB-backed test queues behind other workers'
// DDL lock for longer than the default test timeout. No per-file timeout is set here on purpose:
// the suite-wide timeout in bunfig.toml must cover it.
test('a DB-backed test queued behind other workers on the DDL lock still passes', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const locked = new Promise<void>((resolve) => {
    void withClusterDdlLock(async () => {
      resolve()
      await held
    })
  })
  await locked
  setTimeout(release, HELD_MS)
  const schema = await withScratchSchema(async (_sql, name) => name)
  expect(schema).toStartWith('scratch_')
})
