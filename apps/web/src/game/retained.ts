/** One keyed group of display objects and the signature of the inputs that drew it. */
interface Held<T> {
  sig: string
  objects: T[]
}

/**
 * Keeps keyed groups of display objects between frames. A group whose signature is unchanged is
 * left alone; a changed one is rebuilt; one not asked for in a pass is destroyed. Nothing else is
 * touched, so a change to one thing never recreates its neighbours.
 */
export class Retained<T> {
  private held = new Map<string, Held<T>>()
  private seen = new Set<string>()

  constructor(private readonly destroy: (object: T) => void) {}

  /** Starts a pass: every group must be asked for again with `group` or `end` destroys it. */
  begin(): void {
    this.seen = new Set()
  }

  /** Keeps the group `key` when `sig` is unchanged, else destroys it and builds it afresh. */
  group(key: string, sig: string, build: () => T[]): void {
    this.seen.add(key)
    const found = this.held.get(key)
    if (found && found.sig === sig) {
      return
    }
    if (found) {
      found.objects.forEach(this.destroy)
    }
    this.held.set(key, { sig, objects: build() })
  }

  /** Ends the pass: destroys every group that was not asked for. */
  end(): void {
    for (const [key, entry] of this.held) {
      if (!this.seen.has(key)) {
        entry.objects.forEach(this.destroy)
        this.held.delete(key)
      }
    }
  }
}
