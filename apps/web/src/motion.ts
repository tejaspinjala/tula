/** True when the user asked for reduced motion; no `matchMedia` means no preference. */
export function prefersReducedMotion(
  matchMedia: ((query: string) => { matches: boolean }) | undefined
): boolean {
  return matchMedia ? matchMedia('(prefers-reduced-motion: reduce)').matches : false
}

/** The scroll behavior for scripted scrolling: instant under reduced motion. */
export function scrollBehavior(reduced: boolean): 'auto' | 'smooth' {
  return reduced ? 'auto' : 'smooth'
}
