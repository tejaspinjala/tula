import { z } from 'zod'
import type { CharterPreview, SettingChange } from './diff'

/** One titled group of plain-language change lines in the Charter preview. */
export interface ChangeGroup {
  title: string
  lines: string[]
}

const named = z.looseObject({ name: z.string().optional(), id: z.string().optional() })

/** Turns a stored value (JSON text from the diff) into words: names, not braces. */
function words(raw: string): string {
  if (raw === 'null' || raw === '(none)') {
    return 'none'
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return raw
  }
  if (value === null) {
    return 'none'
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'none' : `${value.length} listed`
  }
  const object = named.safeParse(value)
  if (object.success) {
    return object.data.name ?? object.data.id ?? 'set'
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : raw
}

function spaced(key: string): string {
  const text = key.replace(/([A-Z])/g, ' $1').toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

type Bucket = 'halls' | 'members' | 'caps' | 'seal' | 'routing' | 'other'

function place(change: SettingChange): { bucket: Bucket; line: string } {
  const parts = change.label.split('.')
  const from = words(change.from)
  const to = words(change.to)
  const moves = `changes from ${from} to ${to}`
  const [head = '', second = '', third] = parts
  if (head === 'halls' && third === 'members') {
    return { bucket: 'members', line: `Hall ${second} Members change from ${from} to ${to}` }
  }
  if (head === 'halls' && third !== undefined) {
    return {
      bucket: 'halls',
      line: `Hall ${second}: ${spaced(third)} ${moves}`,
    }
  }
  if (head === 'caps') {
    return { bucket: 'caps', line: `${spaced(second)} cap ${moves}` }
  }
  if (head === 'sealPolicy') {
    return { bucket: 'seal', line: `Seal Policy ${moves}` }
  }
  if (head === 'providers') {
    const verb = to === 'added' ? 'added' : to === 'none' ? 'removed' : undefined
    if (third === undefined && second !== '' && verb !== undefined && parts.length === 2) {
      return { bucket: 'routing', line: `Provider ${second} will be ${verb}` }
    }
    return {
      bucket: 'routing',
      line:
        third === undefined
          ? `Provider ${second} ${moves}`
          : `Provider ${second}: ${spaced(third)} ${moves}`,
    }
  }
  if (head === 'routing' || head === 'profiles' || head === 'routingProfiles') {
    return { bucket: 'routing', line: `${spaced(parts.slice(1).join(' ') || head)} ${moves}` }
  }
  return { bucket: 'other', line: `${spaced(parts.join(' '))} ${moves}` }
}

/**
 * The Charter preview as grouped, plain-language lines (Halls, Members, Caps, Seal Policy, Routing,
 * Rites, other settings, and what stays from this guild). Empty groups are left out.
 */
export function changeGroups(preview: CharterPreview): ChangeGroup[] {
  const buckets: Record<Bucket, string[]> = {
    halls: [
      ...preview.hallsAdded.map((name) => `Hall ${name} will be added`),
      ...preview.hallsRemoved.map((name) => `Hall ${name} will be removed`),
    ],
    members: [],
    caps: [],
    seal: [],
    routing: [],
    other: [],
  }
  for (const change of preview.settings) {
    const { bucket, line } = place(change)
    buckets[bucket].push(line)
  }
  const groups: ChangeGroup[] = [
    { title: 'Halls', lines: buckets.halls },
    { title: 'Members', lines: buckets.members },
    { title: 'Caps', lines: buckets.caps },
    { title: 'Seal Policy', lines: buckets.seal },
    { title: 'Routing', lines: buckets.routing },
    {
      title: 'Rites',
      lines: preview.ritesAdded.map((name) => `Rite ${name} will be added as a draft`),
    },
    { title: 'Other settings', lines: buckets.other },
    { title: 'Kept from this guild', lines: preview.kept },
  ]
  return groups.filter((group) => group.lines.length > 0)
}
