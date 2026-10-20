import { MemorySandboxRunner } from '../adapters/memory-sandbox-runner'
import type { Sandbox, SandboxSpec } from '../ports/sandbox-runner'

/**
 * Test-only {@link MemorySandboxRunner} that remembers every spec it was started with, so a
 * scripted Member can pick up the run token and lease handle the dispatcher handed its sandbox.
 */
export class RecordingSandboxRunner extends MemorySandboxRunner {
  private readonly specs: SandboxSpec[] = []

  override async start(guildId: string, spec: SandboxSpec): Promise<Sandbox> {
    this.specs.push(spec)
    return super.start(guildId, spec)
  }

  /** The newest spec started for the Quest. @throws Error if no sandbox was ever started for it. */
  latest(questId: string): SandboxSpec {
    const spec = this.specs.findLast((s) => s.questId === questId)
    if (!spec) {
      throw new Error(`no sandbox was started for quest ${questId}`)
    }
    return spec
  }
}
