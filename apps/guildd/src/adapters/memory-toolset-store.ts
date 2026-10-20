import type { ToolsetStore } from '../ports/toolset-store'

/**
 * Memory {@link ToolsetStore}. The check and the write happen in one synchronous step, so racing
 * freezes agree. State lives in the instance.
 */
export class MemoryToolsetStore implements ToolsetStore {
  private readonly frozen = new Map<string, string[]>()

  async freeze(
    guildId: string,
    scope: string,
    role: string,
    tools: readonly string[]
  ): Promise<string[]> {
    const key = JSON.stringify([guildId, scope, role])
    const existing = this.frozen.get(key)
    if (existing) {
      return [...existing]
    }
    this.frozen.set(key, [...tools])
    return [...tools]
  }
}
