import type { KillTarget, Sandbox, SandboxRunner, SandboxSpec } from '../ports/sandbox-runner'

/** Memory {@link SandboxRunner}: sandboxes are records in this instance, killed synchronously. */
export class MemorySandboxRunner implements SandboxRunner {
  private readonly running = new Map<string, Sandbox>()

  async start(guildId: string, spec: SandboxSpec): Promise<Sandbox> {
    const sandbox: Sandbox = { sandboxId: crypto.randomUUID(), guildId, questId: spec.questId }
    this.running.set(sandbox.sandboxId, sandbox)
    return sandbox
  }

  async kill(target: KillTarget): Promise<number> {
    let killed = 0
    for (const [id, sandbox] of this.running) {
      if (
        target === 'all' ||
        (sandbox.guildId === target.guildId &&
          (target.questId === undefined || sandbox.questId === target.questId))
      ) {
        this.running.delete(id)
        killed += 1
      }
    }
    return killed
  }

  async list(guildId: string): Promise<Sandbox[]> {
    return [...this.running.values()].filter((s) => s.guildId === guildId)
  }
}
