import { mkdtemp } from 'node:fs/promises'
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
