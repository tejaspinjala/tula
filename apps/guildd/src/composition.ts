import type { Hono } from 'hono'
import { SystemClock } from './adapters/system-clock'
import { type AppDeps, createApp } from './app'

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass memory adapters, production passes none.
 */
export function compose(overrides: Partial<AppDeps> = {}): { app: Hono; adapters: AppDeps } {
  const adapters: AppDeps = { clock: new SystemClock(), ...overrides }
  return { app: createApp(adapters), adapters }
}
