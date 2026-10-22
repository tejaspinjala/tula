import { z } from 'zod'
import type { BuilderConfig } from '../builder/model'
import type { Charter } from './schema'

/** One setting an import would change. */
export interface SettingChange {
  label: string
  from: string
  to: string
}

/** What importing a Charter would do, shown before anything is sent. */
export interface CharterPreview {
  hallsAdded: string[]
  hallsRemoved: string[]
  settings: SettingChange[]
  ritesAdded: string[]
  kept: string[]
}

const NOT_SETTINGS = new Set(['steward', 'halls', 'learningRepos', 'providers'])
const providers = z.array(
  z.looseObject({ id: z.string(), privateEligible: z.boolean().optional() })
)

function show(value: unknown): string {
  if (value === undefined) {
    return '(none)'
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

const memberList = z.array(z.object({ name: z.string(), rank: z.string().optional() })).catch([])

function memberNames(value: unknown): string {
  const names = memberList.parse(value).map((m) => (m.rank ? `${m.name} (${m.rank})` : m.name))
  return names.length > 0 ? names.join(', ') : '(none)'
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).catch({}).parse(value)
}

function providersOf(config: BuilderConfig) {
  return providers.catch([]).parse(Reflect.get(config, 'providers'))
}

/** Compares this guild's config with a Charter's: Halls, caps, Seal Policy and the rest, Rites to add, fields kept. */
export function previewCharter(current: BuilderConfig, charter: Charter): CharterPreview {
  const next = charter.config
  const have = new Set(current.halls.map((h) => h.id))
  const want = new Set(next.halls.map((h) => h.id))
  const settings: SettingChange[] = []
  const compare = (label: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      settings.push({ label, from: show(from), to: show(to) })
    }
  }
  for (const [key, value] of Object.entries(record(next.steward))) {
    compare(`steward.${key}`, record(current.steward)[key], value)
  }
  for (const key of Object.keys(record(current.steward))) {
    if (!(key in record(next.steward))) {
      compare(`steward.${key}`, record(current.steward)[key], undefined)
    }
  }
  const hallsHere = new Map(current.halls.map((h) => [h.id, record(h)]))
  for (const hall of next.halls) {
    const mine = hallsHere.get(hall.id)
    if (!mine) {
      continue
    }
    const theirs = record(hall)
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      if (key === 'id' || key === 'privateEligible') {
        continue
      }
      if (key === 'members') {
        if (JSON.stringify(mine.members) !== JSON.stringify(theirs.members)) {
          settings.push({
            label: `halls.${hall.id}.members`,
            from: memberNames(mine.members),
            to: memberNames(theirs.members),
          })
        }
      } else {
        compare(`halls.${hall.id}.${key}`, mine[key], theirs[key])
      }
    }
  }
  const providersHere = new Map(providersOf(current).map((p) => [p.id, record(p)]))
  const providersThere = new Map(providersOf(next).map((p) => [p.id, record(p)]))
  for (const [id, theirs] of providersThere) {
    const mine = providersHere.get(id)
    if (!mine) {
      compare(`providers.${id}`, undefined, 'added')
      continue
    }
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      if (key !== 'id' && key !== 'privateEligible') {
        compare(`providers.${id}.${key}`, mine[key], theirs[key])
      }
    }
  }
  for (const id of providersHere.keys()) {
    if (!providersThere.has(id)) {
      compare(`providers.${id}`, 'present', undefined)
    }
  }
  const before = record(current)
  const after = record(next)
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOT_SETTINGS.has(key)) {
      continue
    }
    if (key === 'caps') {
      const a = record(before.caps)
      const b = record(after.caps)
      for (const cap of new Set([...Object.keys(a), ...Object.keys(b)])) {
        compare(`caps.${cap}`, a[cap], b[cap])
      }
    } else {
      compare(key, before[key], after[key])
    }
  }
  const kept: string[] = []
  if (Reflect.get(current, 'learningRepos') !== undefined) {
    kept.push('learningRepos (your own repo list)')
  }
  const sharedProviders = providersOf(next).map((p) => p.id)
  const privateKept = [
    ...current.halls.filter((h) => h.privateEligible && want.has(h.id)).map((h) => h.name),
    ...providersOf(current)
      .filter((p) => p.privateEligible && sharedProviders.includes(p.id))
      .map((p) => p.id),
  ]
  if (privateKept.length > 0) {
    kept.push(`privateEligible on ${privateKept.join(', ')} (your own attestations)`)
  }
  settings.sort((a, b) => a.label.localeCompare(b.label))
  return {
    hallsAdded: next.halls.filter((h) => !have.has(h.id)).map((h) => h.name),
    hallsRemoved: current.halls.filter((h) => !want.has(h.id)).map((h) => h.name),
    settings,
    ritesAdded: charter.rites.map((r) => r.name),
    kept,
  }
}
