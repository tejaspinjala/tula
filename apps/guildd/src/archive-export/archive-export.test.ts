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
    includePrivate: false,
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
    expect(file(a, 'Engineering/Same (2).md')).toContain('id: "2"')
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
  test('private targets are linked when exported', () => {
    const files = run([
      note({ id: '1', title: 'S', body: '[[P]]' }),
      note({ id: '2', title: 'P', hallId: 'health', dataClass: 'private' }),
    ])
    expect(file(files, 'Engineering/S.md')).toContain('[[Private/Health/P|P]]')
  })
})

describe('link resolution (ADR-0015)', () => {
  const bodyOf = (body: string, extra: ExportNote[] = []) =>
    file(run([note({ id: '1', title: 'S', body }), ...extra]), 'Engineering/S.md')
  test.each([
    ['[[Knee [left] pain]]', 'Knee [left] pain'],
    ['[[Health diary|my diary]]', 'my diary'],
    ['[[Health diary#2024]]', 'Health diary#2024'],
    ['[[Diary [2026]]]', 'Diary [2026]'],
    ['[[Diary [2026]]]]', 'Diary [2026]'],
  ])('an unexported %s is the plain text the author wrote', (link, shown) => {
    expect(bodyOf(`see ${link} end`)).toContain(`see ${shown} end`)
  })
  test('no [withheld] marker exists', () => {
    expect(bodyOf('[[Secret]]')).not.toContain('[withheld]')
  })
  test('a public note sharing a title resolves to the public file', () => {
    const c = bodyOf('[[Twin]]', [note({ id: '2', title: 'Twin', body: 'pub' })])
    expect(c).toContain('[[Engineering/Twin|Twin]]')
  })
  test('an exported bracketed title resolves to a working link', () => {
    const c = bodyOf('[[Market [stalls] "list"]]', [
      note({ id: '2', title: 'Market [stalls] "list"' }),
    ])
    expect(c).toContain('[[Engineering/Market stalls list|Market stalls "list"]]')
  })
  test('a title ending in a bracket resolves when exported, next to a longer exported title', () => {
    const c = bodyOf('[[Diary [2026]]] and [[Diary [2026] public]]', [
      note({ id: '2', title: 'Diary [2026]' }),
      note({ id: '3', title: 'Diary [2026] public' }),
    ])
    expect(c).toContain(
      '[[Engineering/Diary 2026|Diary 2026]] and [[Engineering/Diary 2026 public|Diary 2026 public]]'
    )
  })
  test('an alias and a heading to an exported note are kept', () => {
    const c = bodyOf('[[P#Part two|see this]] and [[P#^b1]]', [note({ id: '2', title: 'P' })])
    expect(c).toContain('[[Engineering/P#Part two|see this]]')
    expect(c).toContain('[[Engineering/P#^b1|P]]')
  })
  test('a nested [[ resolves the innermost link and leaves no stray brackets', () => {
    const c = bodyOf('[[a [[P]] b]] [[[[P]]]]', [note({ id: '2', title: 'P' })])
    const text = c.slice(c.indexOf('# S'))
    expect(text.match(/\[\[/g)?.length).toBe(text.match(/\]\]/g)?.length)
    expect(text).toContain('[[Engineering/P|P]]')
  })
  test('unresolved nested or dangling brackets leave no wiki brackets', () => {
    for (const body of [
      '[[a [[Gone]] b]]',
      '[[x|[[Gone]]',
      '[[ [[Gone]]',
      '[[[Gone]]]',
      '[[Gone',
    ]) {
      const c = bodyOf(body)
      expect(c.slice(c.indexOf('# S'))).not.toMatch(/\[\[|\]\]/)
    }
  })
  test('ordinary prose is untouched', () => {
    expect(bodyOf('I keep a diary. Plain [[Ghost]] text.')).toContain(
      'I keep a diary. Plain Ghost text.'
    )
  })
  test('index says private notes are not included, with no count, in default mode', () => {
    const idx = file(run([note({ id: '1', title: 'S' })]), 'Archive.md')
    expect(idx).toContain('Private notes are not included in this export.')
    expect(idx).not.toMatch(/left out|\d private/i)
  })
  test('index says private notes are included under Private/ in private mode', () => {
    const idx = file(run([note({ id: '1', title: 'S' })], { includePrivate: true }), 'Archive.md')
    expect(idx).toContain('Private notes are included, under Private/.')
  })
})

describe('indistinguishability property (ADR-0015)', () => {
  const titles = [
    'Plain',
    'Diary [2026]',
    'Notes ]]',
    'Tail]',
    'a|b',
    'h#x',
    'Café',
    'Café',
    'zero​width',
    'Knee [left] pain',
  ]
  const pieces = ['[[', ']]', '[', ']', '|', '#', '^', ' ', 'x', ...titles]
  function seeded(seed: number) {
    let s = seed
    return (n: number): number => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s % n
    }
  }
  test('the export depends only on exported notes, and every [[link]] points at an exported file', () => {
    const rnd = seeded(11)
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T
    for (let i = 0; i < 1200; i++) {
      const body = () => Array.from({ length: 2 + rnd(14) }, () => pick(pieces)).join('')
      const pub = Array.from({ length: 1 + rnd(4) }, (_, k) =>
        note({ id: `p${k}`, title: pick(titles), body: body() })
      )
      const first = run(pub)
      expect(run(pub)).toEqual(first)
      const paths = new Set(first.map((f) => f.path.replace(/\.md$/, '')))
      for (const f of first) {
        const links = f.content.match(/\[\[[^\]]*\]\]/g) ?? []
        for (const l of links) {
          const path = (l.slice(2, -2).split('|')[0] ?? '').split('#')[0] ?? ''
          expect(paths.has(path)).toBe(true)
        }
      }
    }
  })
})

describe('index', () => {
  test('Archive.md has separate sections and counts', () => {
    const files = run([
      note({ id: '1', title: 'Fact one' }),
      note({ id: '2', title: 'Guess', trust: 'quarantined', evidence: null }),
      note({ id: '3', title: 'Fact two' }),
    ])
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
  })
})
