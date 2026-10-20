import { beforeAll } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { ensureTestDatabase, testDbUrl } from './test-db'

// Bun test preload (see bunfig.toml): one create-if-missing + migrate per `bun test` run.
await ensureTestDatabase()

const count = z.object({ n: z.number() })
let previous = '(the start of the run)'

/** How long a transaction another file left open may take to end before it counts as leaked. */
const SETTLE_MS = 1000

/**
 * Before each test file: fails fast, naming the file that ran before, if it left a global bar
 * up or an app session idle in a transaction (background work outliving its test). Such leftovers
 * leak into the next file as flaky failures; this makes the offender obvious.
 */
beforeAll(async () => {
  const here = Bun.main
  const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  try {
    const gate = count.parse((await owner`select count(*)::int as n from global_gate`)[0]).n
    let open = 0
    for (const deadline = Date.now() + SETTLE_MS; ; ) {
      open = count.parse(
        (
          await owner`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and usename = 'guildhall_app'
              and state like 'idle in transaction%'`
        )[0]
      ).n
      if (open === 0 || Date.now() >= deadline) {
        break
      }
      await Bun.sleep(50)
    }
    if (gate > 0 || open > 0) {
      throw new Error(
        `${previous} left test state behind (global_gate rows: ${gate}, app sessions idle in transaction: ${open}); detected before ${here}`
      )
    }
  } finally {
    await owner.end()
    previous = here
  }
})
