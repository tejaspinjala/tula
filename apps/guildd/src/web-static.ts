import type { Hono } from 'hono'

/** Serves the built web app next to the API (stub: not yet implemented). */
export function withWebApp(app: Hono, _dist: string): Hono {
  return app
}
