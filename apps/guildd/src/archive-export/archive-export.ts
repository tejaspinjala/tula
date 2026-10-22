import { type Note, parseWikiLinks, titleKey } from '../ports/note-store'

/** A note to export; its `hallId` is the Hall it is filed under (null: the Guild Master's own). */
export type ExportNote = Note

/** One file of the export, at a relative POSIX path. */
export interface ExportFile {
  path: string
  content: string
}

/** Input to {@link buildArchiveExport}. */
export interface ArchiveExportInput {
  notes: readonly ExportNote[]
  halls: readonly { id: string; name: string }[]
  guildName: string
  now: Date
  /** Whether private notes are among `notes`; only changes the constant partial-export line of the index. */
  includePrivate: boolean
}

const MAX_NAME = 120
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const FORBIDDEN = new Set([...'/\\:*?"<>|#^[]'])
const GUILD_MASTER = 'Guild Master'

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code < 32 || code === 127
}

function trimDots(value: string): string {
  return value.replace(/^[. ]+|[. ]+$/g, '')
}

/** A file name safe on macOS, Windows and Linux: forbidden characters stripped, reserved names suffixed, length capped. */
export function sanitiseFileName(name: string): string {
  const kept = [...name].filter((ch) => !FORBIDDEN.has(ch) && !isControl(ch)).join('')
  const base = trimDots(trimDots(kept.replace(/\s+/g, ' ')).slice(0, MAX_NAME))
  if (!base) {
    return 'untitled'
  }
  const stem = base.split('.')[0] ?? base
  return RESERVED.test(stem.trim()) ? `${base}_` : base
}

/** A YAML double-quoted scalar: JSON escaping plus the Unicode line separators. */
function yamlString(value: string): string {
  return JSON.stringify(value)
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
    .replaceAll('\u0085', '\\u0085')
}

function byId(a: ExportNote, b: ExportNote): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Text that stays plain: any `[[` or `]]` collapses to a single bracket, so it can never form a link. */
function plain(text: string): string {
  let out = text
  while (out.includes('[[') || out.includes(']]')) {
    out = out.replaceAll('[[', '[').replaceAll(']]', ']')
  }
  return out
}

function aliasOf(title: string): string {
  return oneLine([...title].filter((ch) => !'|[]'.includes(ch)).join(''))
}

/** Builds the linked-Markdown Archive export (ADR-0015): one file per note plus `Archive.md`. Pure. */
export function buildArchiveExport(input: ArchiveExportInput): ExportFile[] {
  const hallName = (id: string | null): string => {
    if (id === null) {
      return GUILD_MASTER
    }
    return input.halls.find((h) => h.id === id)?.name ?? id
  }
  const notes = [...input.notes].sort(byId)

  // Paths are assigned in id order; collisions are case-insensitive (macOS and Windows).
  const taken = new Set<string>()
  const pathOf = new Map<string, string>()
  for (const n of notes) {
    const hall = sanitiseFileName(hallName(n.hallId))
    const dir = n.dataClass === 'private' ? `Private/${hall}` : hall
    const base = sanitiseFileName(n.title)
    let name = base
    for (let k = 2; taken.has(`${dir}/${name}`.toLowerCase()); k++) {
      name = `${base} (${k})`
    }
    taken.add(`${dir}/${name}`.toLowerCase())
    pathOf.set(n.id, `${dir}/${name}`)
  }

  const byKey = new Map<string, ExportNote>()
  for (const n of notes) {
    const key = titleKey(n.title)
    if (!byKey.has(key)) {
      byKey.set(key, n)
    }
  }
  // Only exported titles are `known`, so nothing here can depend on a private note. A link whose
  // target is not exported (private or missing alike) becomes the plain text the author wrote.
  const rewrite = (body: string): string => {
    let out = ''
    let at = 0
    let fenced = false
    // Edge brackets beside a plain replacement are dropped so none can pair into `[[`.
    const gap = (text: string): string => plain(fenced ? text.replace(/^\]+/, '') : text)
    for (const link of parseWikiLinks(body, (k) => byKey.has(k))) {
      out += gap(body.slice(at, link.start))
      at = link.end
      const target = byKey.get(titleKey(link.target))
      const path = target ? pathOf.get(target.id) : undefined
      if (target && path !== undefined) {
        const label = link.alias === null ? '' : aliasOf(link.alias)
        const heading = link.heading === null ? '' : `#${oneLine(link.heading)}`
        out += `[[${path}${heading}|${label || aliasOf(target.title)}]]`
        fenced = false
      } else {
        out = out.replace(/\[+$/, '')
        const shown =
          link.alias ?? (link.heading === null ? link.target : `${link.target}#${link.heading}`)
        out += plain(oneLine(shown))
        fenced = true
      }
    }
    return out + gap(body.slice(at))
  }

  const files: ExportFile[] = notes.map((n) => {
    const quarantined = n.trust === 'quarantined'
    const lines = [
      '---',
      `id: ${yamlString(n.id)}`,
      `hall: ${yamlString(hallName(n.hallId))}`,
      `trust: ${yamlString(n.trust)}`,
      `claim: ${quarantined ? 'assumption' : 'fact'}`,
      `evidence: ${n.evidence === null ? 'null' : yamlString(n.evidence)}`,
      `version: ${n.version}`,
      `kind: ${n.kind}`,
    ]
    if (n.kind === 'link') {
      lines.push(`url: ${yamlString(n.body)}`)
    }
    if (quarantined) {
      lines.push('tags: [quarantined]')
    }
    lines.push('---', '', `# ${oneLine(n.title)}`, '')
    lines.push(n.kind === 'link' ? `<${n.body}>` : rewrite(n.body))
    return { path: `${pathOf.get(n.id)}.md`, content: `${lines.join('\n')}\n` }
  })

  const entry = (n: ExportNote): string => `- [[${pathOf.get(n.id)}|${aliasOf(n.title)}]]`
  const facts = notes.filter((n) => n.trust === 'fact')
  const assumptions = notes.filter((n) => n.trust === 'quarantined')
  const index = [
    `# ${oneLine(input.guildName)} Archive`,
    '',
    `Exported ${input.now.toISOString().slice(0, 10)}.`,
    '',
    `Notes exported: ${notes.length}`,
    input.includePrivate
      ? 'Private notes are included, under Private/.'
      : 'Private notes are not included in this export.',
    '',
    `## Facts (${facts.length})`,
    '',
    ...facts.map(entry),
    '',
    `## Quarantined assumptions (${assumptions.length})`,
    '',
    ...assumptions.map(entry),
    '',
  ]
  return [{ path: 'Archive.md', content: index.join('\n') }, ...files]
}
