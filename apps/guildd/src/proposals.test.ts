import { expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { defaultConfig } from './guild-config'
import { ProposalEngine } from './proposals'

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const engine = new ProposalEngine({ store: new MemoryProposalStore(clock), config })
  return { config, guild, engine }
}
const draft = (content: string) => ({
  questId: crypto.randomUUID(),
  author: 'herald-1',
  kind: 'post',
  content,
})

test("a Verdict applies the guild's own content policy from its config", async () => {
  const { config, guild, engine } = await setup()
  expect((await engine.propose(guild, draft('We love free money'))).verdict.passed).toBe(true)
  const next = {
    ...defaultConfig(),
    contentPolicy: { maxLength: 100, bannedTerms: ['free money'], requiredTerms: ['guildhall'] },
  }
  await config.propose(guild, next)
  const banned = await engine.propose(guild, draft('We love free money, guildhall'))
  expect(banned.verdict.passed).toBe(false)
  const missing = await engine.propose(guild, draft('A fine post'))
  expect(missing.verdict.findings.find((f) => f.check === 'required_terms')?.passed).toBe(false)
  expect((await engine.propose(guild, draft('A fine guildhall post'))).verdict.passed).toBe(true)
})
