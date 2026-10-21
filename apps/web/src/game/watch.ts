/** The part of a ResizeObserver this module needs. */
interface SizeObserver<T> {
  observe: (target: T) => void
  disconnect: () => void
}

/** The two calls of Phaser's ScaleManager a refit needs. */
interface RefitScale {
  getParentBounds: () => boolean
  refresh: () => unknown
}

/**
 * Re-reads the parent's size, then refreshes the game to it when it moved. Phaser's `refresh`
 * alone reuses the size it measured at boot, and Phaser 4 does not poll the parent.
 */
export function refitScale(scale: RefitScale): void {
  void scale
}

/**
 * Calls `onResize` whenever `target` changes size, and returns a function that stops watching.
 * The frame moves when the HUD changes height, which the window `resize` event never reports.
 */
export function watchSize<T>(
  target: T,
  onResize: () => void,
  Observer: (new (callback: () => void) => SizeObserver<T>) | undefined
): () => void {
  if (!Observer) {
    return () => {}
  }
  const observer = new Observer(onResize)
  observer.observe(target)
  return () => observer.disconnect()
}
