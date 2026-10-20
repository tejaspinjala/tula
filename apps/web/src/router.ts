import { useCallback, useEffect, useState } from 'react'

/** The Bag's pages, in menu order. */
export const BAG_PAGES = [] as const

/** The id of one Bag page. */
export type PageId = never

/** Which Bag page a location opens, or null for the bare world. */
export function pageFor(_pathname: string, _search: string): PageId | null {
  return null
}

/** Whether `pathname` is the world or a Bag page path; anything else redirects to `/`. */
export function isKnownPath(_pathname: string): boolean {
  return true
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
    window.history.pushState({}, '', path)
    setPage(pageFor(window.location.pathname, window.location.search))
  }, [])
  return { page, navigate }
}
