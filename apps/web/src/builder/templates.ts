import type { BuilderConfig, BuilderHall } from './model'

/** A prebuilt Hall the palette offers. */
export interface HallTemplate {
  id: string
  label: string
  hall: BuilderHall
}

/** The prebuilt Halls. */
export const TEMPLATES: HallTemplate[] = []

/** Adds a prebuilt Hall to a config with fresh ids. */
export function instantiate(_c: BuilderConfig, _t: HallTemplate): BuilderConfig {
  throw new Error('not implemented')
}
