import { expect, test } from 'bun:test'
import { extractSuggestions } from './learning'

const input = {
  repo: 'tula-solutions/guildhall',
  pulls: [
    {
      number: 12,
      title: 'Add retry to the push relay',
      body: 'Retries now back off.\r\n\r\nCloses #9',
      mergedAt: '2026-01-02T00:00:00Z',
      url: 'https://github.com/tula-solutions/guildhall/pull/12',
    },
    {
      number: 7,
      title: 'Fix typo',
      body: null,
      mergedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/tula-solutions/guildhall/pull/7',
    },
  ],
  adrs: [
    { name: '0007-use-row-level-security.md', path: 'docs/adr/0007-use-row-level-security.md' },
    { name: 'README.md', path: 'docs/adr/README.md' },
    { name: 'img', path: 'docs/adr/img' },
  ],
}

const expected = [
  {
    sourceId: 'adr:tula-solutions/guildhall:docs/adr/0007-use-row-level-security.md',
    repo: 'tula-solutions/guildhall',
    kind: 'adr',
    title: 'ADR 0007: Use row level security',
    body: 'A new decision record in tula-solutions/guildhall: ADR 0007, Use row level security.',
    url: 'https://github.com/tula-solutions/guildhall/blob/HEAD/docs/adr/0007-use-row-level-security.md',
  },
  {
    sourceId: 'pr:tula-solutions/guildhall#12',
    repo: 'tula-solutions/guildhall',
    kind: 'pr',
    title: 'tula-solutions/guildhall#12: Add retry to the push relay',
    body: 'Merged pull request: Add retry to the push relay\n\nRetries now back off.\n\nCloses #9',
    url: 'https://github.com/tula-solutions/guildhall/pull/12',
  },
  {
    sourceId: 'pr:tula-solutions/guildhall#7',
    repo: 'tula-solutions/guildhall',
    kind: 'pr',
    title: 'tula-solutions/guildhall#7: Fix typo',
    body: 'Merged pull request: Fix typo',
    url: 'https://github.com/tula-solutions/guildhall/pull/7',
  },
]

test('extraction is deterministic: same input, same suggestions, ordered by source id', () => {
  expect(extractSuggestions(input)).toEqual(expected)
  expect(extractSuggestions(structuredClone(input))).toEqual(expected)
  expect(
    extractSuggestions({
      ...input,
      pulls: [...input.pulls].reverse(),
      adrs: [...input.adrs].reverse(),
    })
  ).toEqual(expected)
})

test('titles and bodies are bounded to what an Archive note accepts', () => {
  const [one] = extractSuggestions({
    repo: 'o/r',
    pulls: [
      {
        number: 1,
        title: 't'.repeat(500),
        body: 'b'.repeat(50_000),
        mergedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/o/r/pull/1',
      },
    ],
    adrs: [],
  })
  expect(one?.title.length).toBeLessThanOrEqual(200)
  expect(one?.body.length).toBeLessThanOrEqual(4000)
})
