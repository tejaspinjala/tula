import { useCallback, useEffect, useState } from 'react'

/** The ledger's views, in navigation order. */
export const VIEWS = [
  { id: 'home', path: '/', label: 'Home' },
  { id: 'hall', path: '/hall', label: 'Guild Hall' },
  { id: 'quests', path: '/quests', label: 'Quest Board' },
  { id: 'seals', path: '/seals', label: 'Seals' },
  { id: 'archive', path: '/archive', label: 'Archive' },
  { id: 'treasury', path: '/treasury', label: 'Treasury and Costs' },
  { id: 'roster', path: '/roster', label: 'Roster and Summon' },
  { id: 'guild', path: '/guild', label: 'Guild' },
  { id: 'workflows', path: '/workflows', label: 'Workflows' },
  { id: 'gates', path: '/gates', label: 'Gates' },
  { id: 'timeline', path: '/timeline', label: 'Timeline' },
  { id: 'vault', path: '/vault', label: 'Vault and Settings' },
] as const

/** The id of one ledger view. */
export type ViewId = (typeof VIEWS)[number]['id']

/**
 * Which view a location opens. A tapped Seal push link (`/?seal=<id>`) opens the Seals view;
 * any unknown path opens Home.
 */
export function viewFor(pathname: string, search: string): ViewId {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const found = VIEWS.find((view) => view.path === trimmed)
  if (found && found.id !== 'home') {
    return found.id
  }
  return new URLSearchParams(search).has('seal') ? 'seals' : 'home'
}

/** Whether `pathname` is `/` or one of the ledger's view paths; anything else redirects to `/`. */
export function isKnownPath(pathname: string): boolean {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return VIEWS.some((view) => view.path === trimmed)
}

/** The current view and a `navigate` that changes the path without a page load. */
export function useRoute(): { view: ViewId; navigate: (path: string) => void } {
  const [view, setView] = useState<ViewId>(() =>
    viewFor(window.location.pathname, window.location.search)
  )
  useEffect(() => {
    const sync = () => {
      if (!isKnownPath(window.location.pathname)) {
        window.history.replaceState({}, '', '/')
      }
      setView(viewFor(window.location.pathname, window.location.search))
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])
  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path)
    setView(viewFor(window.location.pathname, window.location.search))
    window.scrollTo?.(0, 0)
    document.getElementById('main')?.focus()
  }, [])
  return { view, navigate }
}
