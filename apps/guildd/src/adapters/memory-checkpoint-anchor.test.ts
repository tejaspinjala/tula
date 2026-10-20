import { checkpointAnchorContract } from '../ports/checkpoint-anchor.contract'
import { MemoryCheckpointAnchor } from './memory-checkpoint-anchor'

checkpointAnchorContract('memory', async () => {
  const anchor = new MemoryCheckpointAnchor()
  return { anchor, reopen: async () => anchor }
})
