const two = (n: number) => String(n).padStart(2, '0')

/**
 * Formats an ISO timestamp for the game: local time as HH:MM, with the local date (YYYY-MM-DD)
 * in front when it is not today. An unreadable value is returned as given.
 */
export function formatGameTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    return iso
  }
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return sameDay
    ? time
    : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${time}`
}
