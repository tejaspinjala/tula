import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'
import { z } from 'zod'
import {
  type ArchiveExportInput,
  buildArchiveExport,
  type ExportNote,
  sanitiseFileName,
} from './archive-export'

const halls = [
  { id: 'eng', name: 'Engineering' },
  { id: 'health', name: 'Health' },
]
const NOW = new Date('2026-01-02T03:04:05Z')

function note(over: Partial<ExportNote> & { id: string; title: string }): ExportNote {
  return {
    kind: 'text',
    body: 'body',
    trust: 'fact',
    evidence: 'seen',
    version: 1,
    dataClass: 'internal',
    hallId: 'eng',
    ...over,
  }
}

function run(notes: ExportNote[], extra: Partial<ArchiveExportInput> = {}) {
  return buildArchiveExport({
    notes,
    halls,
    guildName: 'Tula',
    now: NOW,
    privateLeftOut: 0,
    ...extra,
  })
}

function file(files: { path: string; content: string }[], path: string): string {
  const f = files.find((x) => x.path === path)
  if (!f) {
    throw new Error(`missing ${path}: ${files.map((x) => x.path).join(', ')}`)
  }
  return f.content
}

const fm = z.object({ id: z.string() }).loose()
function front(content: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content)
  if (!m) {
    throw new Error('no front matter')
  }
  return fm.parse(parse(m[1] ?? ''))
}

describe('sanitiseFileName', () => {
  test('strips forbidden characters', () => {
    expect(sanitiseFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe('abcdefghijklmn')
  })
  test('trims dots and spaces', () => {
    expect(sanitiseFileName('  ..name. . ')).toBe('name')
  })
  test('avoids reserved Windows names', () => {
    expect(sanitiseFileName('CON')).toBe('CON_')
    expect(sanitiseFileName('com1')).toBe('com1_')
    expect(sanitiseFileName('Lpt9.txt')).toBe('Lpt9.txt_')
    expect(sanitiseFileName('CONSOLE')).toBe('CONSOLE')
  })
  test('caps the length', () => {
    expect(sanitiseFileName('x'.repeat(500)).length).toBe(120)
  })
  test('falls back when nothing is left', () => {
    expect(sanitiseFileName('???')).toBe('untitled')
  })
})

describe('paths', () => {
  test('files go under their Hall, Guild Master, or Private', () => {
    const files = run([
      note({ id: '1', title: 'A' }),
      note({ id: '2', title: 'B', hallId: null }),
      note({ id: '3', title: 'C', hallId: 'health', dataClass: 'private' }),
    ])
    expect(files.map((f) => f.path).sort()).toEqual([
      'Archive.md',
      'Engineering/A.md',
      'Guild Master/B.md',
      'Private/Health/C.md',
    ])
  })
  test('collisions get deterministic suffixes in id order', () => {
    const a = run([note({ id: '2', title: 'Same' }), note({ id: '1', title: 'same?' })])
    expect(file(a, 'Engineering/same.md')).toContain('id: "1"')
    expect(file(a, 'Engineering/same (2).md')).toContain('id: "2"')
  })
})

describe('front matter', () => {
  test('every block parses back to the original values', () => {
    const tricky = [
      'a: b',
      'say "hi"',
      '- dash',
      'two\nlines',
      "it's #1 [x] {y}",
      'true',
      'e',
      'back\\slash',
    ]
    const notes = tricky.map((t, i) =>
      note({
        id: `n${i}`,
        title: `T${i}`,
        evidence: t,
        kind: i === 0 ? 'link' : 'text',
        body: i === 0 ? 'https://example.com/a?b=c' : 'x',
        trust: i % 2 ? 'quarantined' : 'fact',
      })
    )
    const files = run(notes)
    const blocks = files.filter((f) => f.path !== 'Archive.md')
    expect(blocks.length).toBe(tricky.length)
    for (const f of blocks) {
      expect(front(f.content).id).toMatch(/^n\d$/)
    }
    expect(front(file(files, 'Engineering/T0.md'))).toMatchObject({
      id: 'n0',
      hall: 'Engineering',
      trust: 'fact',
      claim: 'fact',
      evidence: 'a: b',
      version: 1,
      kind: 'link',
      url: 'https://example.com/a?b=c',
    })
    expect(front(file(files, 'Engineering/T1.md')).evidence).toBe('say "hi"')
    expect(front(file(files, 'Engineering/T2.md')).evidence).toBe('- dash')
    expect(front(file(files, 'Engineering/T3.md')).evidence).toBe('two\nlines')
    expect(front(file(files, 'Engineering/T4.md')).evidence).toBe("it's #1 [x] {y}")
    expect(front(file(files, 'Engineering/T5.md')).evidence).toBe('true')
    expect(front(file(files, 'Engineering/T7.md')).evidence).toBe('back\\slash')
  })
  test('quarantined notes carry the quarantined tag and an assumption claim', () => {
    const files = run([
      note({ id: '1', title: 'Q', trust: 'quarantined', evidence: null }),
      note({ id: '2', title: 'F' }),
    ])
    const q = front(file(files, 'Engineering/Q.md'))
    expect(q.tags).toEqual(['quarantined'])
    expect(q.claim).toBe('assumption')
    expect(q.evidence).toBeNull()
    expect(front(file(files, 'Engineering/F.md')).tags).toBeUndefined()
  })
  test('a title that looks like YAML stays in the heading, not the front matter', () => {
    const files = run([note({ id: '1', title: 'x: y\n---' })])
    expect(file(files, 'Engineering/x y---.md')).toContain('# x: y ---')
  })
})

describe('wiki links', () => {
  test('exported targets are rewritten to file|Title, matched like titleKey', () => {
    const files = run([
      note({ id: '1', title: 'Source', body: 'see [[ target one ]] now' }),
      note({ id: '2', title: 'Target One' }),
    ])
    expect(file(files, 'Engineering/Source.md')).toContain(
      'see [[Engineering/Target One|Target One]] now'
    )
  })
  test('missing targets become plain text', () => {
    const c = file(run([note({ id: '1', title: 'S', body: 'see [[Ghost]]' })]), 'Engineering/S.md')
    expect(c).toContain('see Ghost')
    expect(c).not.toContain('[[Ghost')
  })
  test('withheld private targets never show their title', () => {
    const c = file(
      run([note({ id: '1', title: 'S', body: 'see [[Secret Plan]]' })], {
        privateLeftOut: 1,
        withheldTitles: ['secret plan'],
      }),
      'Engineering/S.md'
    )
    expect(c).not.toMatch(/secret plan/i)
    expect(c).toContain('[withheld]')
  })
  test('private targets are linked when exported', () => {
    const files = run([
      note({ id: '1', title: 'S', body: '[[P]]' }),
      note({ id: '2', title: 'P', hallId: 'health', dataClass: 'private' }),
    ])
    expect(file(files, 'Engineering/S.md')).toContain('[[Private/Health/P|P]]')
  })
})

describe('index', () => {
  test('Archive.md has separate sections, counts and the private count', () => {
    const files = run(
      [
        note({ id: '1', title: 'Fact one' }),
        note({ id: '2', title: 'Guess', trust: 'quarantined', evidence: null }),
        note({ id: '3', title: 'Fact two' }),
      ],
      { privateLeftOut: 4 }
    )
    const idx = file(files, 'Archive.md')
    expect(idx).toContain('# Tula Archive')
    expect(idx).toContain('2026-01-02')
    const facts = idx.indexOf('## Facts (2)')
    const quar = idx.indexOf('## Quarantined assumptions (1)')
    expect(facts).toBeGreaterThan(-1)
    expect(quar).toBeGreaterThan(facts)
    expect(idx.slice(facts, quar)).toContain('[[Engineering/Fact one|Fact one]]')
    expect(idx.slice(facts, quar)).not.toContain('Guess')
    expect(idx.slice(quar)).toContain('[[Engineering/Guess|Guess]]')
    expect(idx).toContain('Private notes left out: 4')
  })
})
