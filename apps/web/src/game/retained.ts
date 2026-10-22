/** Keeps keyed groups of display objects between frames (stub: rebuilds every group). */
export class Retained<T> {
  private held: T[] = []

  constructor(private readonly destroy: (object: T) => void) {}

  /** Starts a pass. */
  begin(): void {
    this.held = []
  }

  /** Builds the group afresh every time, destroying the last one at `end`. */
  group(_key: string, _sig: string, build: () => T[]): void {
    this.held.push(...build())
  }

  /** Ends a pass. */
  end(): void {
    for (const o of this.held) {
      this.destroy(o)
    }
  }
}
