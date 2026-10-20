import { sandboxRunnerContract } from '../ports/sandbox-runner.contract'
import { MemorySandboxRunner } from './memory-sandbox-runner'

sandboxRunnerContract('memory', async () => new MemorySandboxRunner())
