import { coreLoopEndToEnd, type E2eWorld } from './core-loop.e2e'

async function memoryWorld(): Promise<E2eWorld> {
  throw new Error('the memory world is not wired yet')
}

coreLoopEndToEnd('memory', memoryWorld)
