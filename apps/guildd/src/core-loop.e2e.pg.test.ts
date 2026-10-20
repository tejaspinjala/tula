import { coreLoopEndToEnd, type E2eWorld } from './core-loop.e2e'

async function pgWorld(): Promise<E2eWorld> {
  throw new Error('the Postgres world is not wired yet')
}

coreLoopEndToEnd('postgres', pgWorld)
