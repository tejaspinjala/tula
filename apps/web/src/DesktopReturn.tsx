import type { Fetcher } from './artifacts'

/** The step after a browser sign-in opened by the desktop shell: hand the session back to the app. */
export function DesktopReturn({
  fetcher,
  navigate,
}: {
  fetcher: Fetcher
  navigate: (url: string) => void
}) {
  void fetcher
  void navigate
  return null
}
