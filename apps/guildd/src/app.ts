import { Hono } from 'hono'
import type { Clock } from './ports/clock'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
}

/** Builds the guildd HTTP app over the given adapters. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/health', (c) => c.json({ status: 'ok', time: deps.clock.now().toISOString() }))
  return app
}
