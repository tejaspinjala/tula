import { MemoryBugReportStore } from '../adapters/memory-bug-report-store'
import type { MemoryClock } from '../adapters/memory-clock'
import { MemoryDossierStore } from '../adapters/memory-dossier-store'
import type { MemoryProposalStore } from '../adapters/memory-proposal-store'
import type { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemorySealStore } from '../adapters/memory-seal-store'
import type { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { BugReportService } from '../bug-reports'
import { DossierService } from '../dossiers'
import type { McpGatewayDeps } from '../mcp/gateway'
import type { ConfigStore } from '../ports/config-store'
import type { HandoffStore } from '../ports/handoff-store'
import type { ObjectStore } from '../ports/object-store'

/** The collaborators the memory Dossier and Bug Report services of a test gateway share with it. */
export interface GatewayExtrasInput {
  quests: MemoryQuestQueue
  config: ConfigStore
  handoffs: HandoffStore
  objectStore: ObjectStore
  proposals: MemoryProposalStore
  tripwires: MemoryTripwireStore
  clock: MemoryClock
}

/**
 * The memory-backed `dossiers`, `bugReports` and `bugReportStore` every {@link McpGateway} needs,
 * built from the stores the test already shares with the gateway.
 */
export function gatewayExtras(
  input: GatewayExtrasInput
): Pick<McpGatewayDeps, 'dossiers' | 'bugReports' | 'bugReportStore'> {
  const bugs = new MemoryBugReportStore(input.quests)
  return {
    dossiers: new DossierService({
      quests: input.quests,
      handoffs: input.handoffs,
      objectStore: input.objectStore,
      proposals: input.proposals,
      seals: new MemorySealStore(input.clock),
      store: new MemoryDossierStore(),
      clock: input.clock,
    }),
    bugReports: new BugReportService({
      config: input.config,
      store: bugs,
      clock: input.clock,
      tripwires: input.tripwires,
    }),
    bugReportStore: bugs,
  }
}
