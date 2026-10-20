import { useCallback, useEffect, useState } from 'react'

/** The Bag's pages, in menu order. Each opens over the world at its path. */
export const BAG_PAGES = [
  { id: 'quests', path: '/quests', label: 'Quest Board' },
  { id: 'seals', path: '/seals', label: 'Seals' },
  { id: 'treasury', path: '/treasury', label: 'Treasury' },
  { id: 'ledger', path: '/timeline', label: 'Ledger of Deeds' },
  { id: 'guild', path: '/guild', label: 'Guild builder' },
  { id: 'workflows', path: '/workflows', label: 'Workflows' },
  { id: 'missives', path: '/missives', label: 'Guild chat' },
  { id: 'gates', path: '/gates', label: 'Gates' },
  { id: 'settings', path: '/vault', label: 'Settings' },
] as const

/** The id of one Bag page. */
export type PageId = (typeof BAG_PAGES)[number]['id']

/** Older ledger paths (bookmarks, push links) and the page that now holds them. */
const ALIASES: Record<string, PageId | null> = {
  '/': null,
  '/hall': null,
  '/archive': 'ledger',
  '/roster': 'guild',
}

function trimmed(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

/**
 * Which Bag page a location opens, or null for the bare world. A tapped Seal push link
 * (`/?seal=<id>`) opens the Seals page; an explicit page path wins over it.
 */
export function pageFor(pathname: string, search: string): PageId | null {
  const path = trimmed(pathname)
  const found = BAG_PAGES.find((page) => page.path === path)
  if (found) {
    return found.id
  }
  const alias = Object.hasOwn(ALIASES, path) ? ALIASES[path] : null
  if (alias) {
    return alias
  }
  return new URLSearchParams(search).has('seal') ? 'seals' : null
}

/** Whether `pathname` is the world or a Bag page path; anything else redirects to `/`. */
export function isKnownPath(pathname: string): boolean {
  const path = trimmed(pathname)
  return Object.hasOwn(ALIASES, path) || BAG_PAGES.some((page) => page.path === path)
}

/** The open Bag page (null while the world is bare) and a `navigate` that changes the path without a page load. */
export function useRoute(): { page: PageId | null; navigate: (path: string) => void } {
  const [page, setPage] = useState<PageId | null>(() =>
    pageFor(window.location.pathname, window.location.search)
  )
  useEffect(() => {
    const sync = () => {
      if (!isKnownPath(window.location.pathname)) {
        window.history.replaceState({}, '', `/${window.location.search}`)
      }
      setPage(pageFor(window.location.pathname, window.location.search))
    }
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])
  const navigate = useCallback((path: string) => {
    // Closing twice (Esc and a button) must not stack identical history entries.
    const here = `${window.location.pathname}${window.location.search}`
    if (path !== here) {
      window.history.pushState({}, '', path)
    }
    setPage(pageFor(window.location.pathname, window.location.search))
  }, [])
  return { page, navigate }
}
