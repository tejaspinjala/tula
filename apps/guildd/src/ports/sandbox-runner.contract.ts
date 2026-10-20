import { describe, expect, test } from 'bun:test'
import type { SandboxRunner } from './sandbox-runner'

/** The SandboxRunner contract, run against every adapter. `make` returns a fresh runner. */
export function sandboxRunnerContract(name: string, make: () => Promise<SandboxRunner>) {
  describe(`SandboxRunner contract: ${name}`, () => {
    test('a started sandbox is listed for its guild only', async () => {
      const runner = await make()
      const a = crypto.randomUUID()
      const b = crypto.randomUUID()
      const sandbox = await runner.start(a, { questId: 'q1' })
      await runner.start(b, { questId: 'q2' })
      expect((await runner.list(a)).map((s) => s.sandboxId)).toEqual([sandbox.sandboxId])
      expect(await runner.list(crypto.randomUUID())).toEqual([])
    })

    test('killing a guild stops its sandboxes and no other guild', async () => {
      const runner = await make()
      const a = crypto.randomUUID()
      const b = crypto.randomUUID()
      await runner.start(a, { questId: 'q1' })
      await runner.start(a, { questId: 'q2' })
      await runner.start(b, { questId: 'q3' })
      expect(await runner.kill({ guildId: a })).toBe(2)
      expect(await runner.list(a)).toEqual([])
      expect(await runner.list(b)).toHaveLength(1)
    })

    test('killing all stops every guild, and killing again is a no-op', async () => {
      const runner = await make()
      const a = crypto.randomUUID()
      const b = crypto.randomUUID()
      await runner.start(a, { questId: 'q1' })
      await runner.start(b, { questId: 'q2' })
      expect(await runner.kill('all')).toBe(2)
      expect(await runner.list(a)).toEqual([])
      expect(await runner.list(b)).toEqual([])
      expect(await runner.kill('all')).toBe(0)
    })
  })
}
