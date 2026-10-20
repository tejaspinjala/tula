/** "5 minutes ago" style words for an ISO instant; an unreadable instant is returned as it came. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return iso
  }
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (seconds < 45) {
    return 'just now'
  }
  if (seconds < 3600) {
    return unit(Math.max(1, Math.floor(seconds / 60)), 'minute')
  }
  if (seconds < 86_400) {
    return unit(Math.floor(seconds / 3600), 'hour')
  }
  return unit(Math.floor(seconds / 86_400), 'day')
}

/**
 * Folds consecutive rows with the same text into one row carrying a `count`; the row kept is the
 * latest of the run, so its time is when the repeat last happened.
 */
export function groupRepeats<T extends { text: string }>(
  rows: readonly T[]
): Array<T & { count: number }> {
  const grouped: Array<T & { count: number }> = []
  for (const row of rows) {
    const last = grouped.at(-1)
    if (last && last.text === row.text) {
      grouped[grouped.length - 1] = { ...row, count: last.count + 1 }
    } else {
      grouped.push({ ...row, count: 1 })
    }
  }
  return grouped
}

/** A replay state key as words: `awaiting_seal` reads "awaiting Seal", `consumed` reads "posted". */
export function stateWord(key: string): string {
  switch (key) {
    case 'awaiting_seal':
      return 'awaiting Seal'
    case 'consumed':
      return 'posted'
    case 'dead':
      return 'dead-lettered'
    default:
      return key
  }
}
