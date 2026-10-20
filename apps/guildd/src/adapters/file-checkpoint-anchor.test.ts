import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointAnchorContract } from '../ports/checkpoint-anchor.contract'
import { FileCheckpointAnchor } from './file-checkpoint-anchor'

checkpointAnchorContract('file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anchor-'))
  return {
    anchor: new FileCheckpointAnchor(dir),
    reopen: async () => new FileCheckpointAnchor(dir),
  }
})

describe('FileCheckpointAnchor on disk', () => {
  const good = { seq: 4, mac: 'a'.repeat(64), signature: 'b'.repeat(64) }
  const guild = crypto.randomUUID()

  test('a torn (unterminated) trailing line is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchor-'))
    const anchor = new FileCheckpointAnchor(dir)
    await anchor.publish(guild, good)
    await appendFile(join(dir, `${guild}.jsonl`), '{"seq":9,"mac":"cc')
    expect(await anchor.latest(guild)).toEqual(good)
  })

  test('a corrupt terminated line makes latest reject rather than skip it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchor-'))
    const anchor = new FileCheckpointAnchor(dir)
    await anchor.publish(guild, good)
    await appendFile(join(dir, `${guild}.jsonl`), 'not json\n')
    await expect(anchor.latest(guild)).rejects.toThrow()
  })
})
