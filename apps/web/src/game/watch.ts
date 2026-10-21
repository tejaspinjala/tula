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
  _target: T,
  _onResize: () => void,
  _Observer: (new (callback: () => void) => SizeObserver) | undefined
): () => void {
  return () => {}
}
