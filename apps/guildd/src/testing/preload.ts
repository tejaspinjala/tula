import { ensureTestDatabase } from './test-db'

// Bun test preload (see bunfig.toml): one create-if-missing + migrate per `bun test` run.
await ensureTestDatabase()
