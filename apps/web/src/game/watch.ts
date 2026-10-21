/** The part of a ResizeObserver this module needs. */
interface SizeObserver {
  observe: (target: never) => void
  disconnect: () => void
}

/**
 * Calls `onResize` whenever `target` changes size, and returns a function that stops watching.
 * The frame moves when the HUD changes height, which the window `resize` event never reports.
 */
export function watchSize<T>(
  target: T,
  onResize: () => void,
  Observer: (new (callback: () => void) => SizeObserver) | undefined
): () => void {
  if (!Observer) {
    return () => {}
  }
  const observer = new Observer(onResize)
  observer.observe(target as never)
  return () => observer.disconnect()
}
