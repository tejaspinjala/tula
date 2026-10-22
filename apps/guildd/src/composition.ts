import type { Hono } from 'hono'
import { AnthropicModelProvider } from './adapters/anthropic-model-provider'
import { BoundClassifier } from './adapters/bound-classifier'
import { BraveSearchProvider } from './adapters/brave-search-provider'
import { ClaudeCliModelProvider } from './adapters/claude-cli-model-provider'
import { FileCheckpointAnchor } from './adapters/file-checkpoint-anchor'
import { FileKeyProvider } from './adapters/file-key-provider'
import { GitHubRestEnvoy } from './adapters/github-rest-envoy'
import { HttpPageFetcher } from './adapters/http-page-fetcher'
import { MemoryCheckpointAnchor } from './adapters/memory-checkpoint-anchor'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryPageFetcher } from './adapters/memory-page-fetcher'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { MemorySearchProvider } from './adapters/memory-search-provider'
import { PgActivityLog } from './adapters/pg-activity-log'
import { PgAwaitingSealReader } from './adapters/pg-awaiting-seal-reader'
import { PgBugReportStore } from './adapters/pg-bug-report-store'
import { PgCharterImporter } from './adapters/pg-charter-importer'
import { PgConfigStore } from './adapters/pg-config-store'
import { PgCouncilStore } from './adapters/pg-council-store'
import { PgDossierStore } from './adapters/pg-dossier-store'
import { PgGateStore } from './adapters/pg-gate-store'
import { PgGuildMasterLookStore } from './adapters/pg-guild-master-look-store'
import { PgHandoffStore } from './adapters/pg-handoff-store'
import { PgIdentityStore } from './adapters/pg-identity-store'
import { PgInquiryStore } from './adapters/pg-inquiry-store'
import { PgMissiveStore } from './adapters/pg-missive-store'
import { PgModelLedger } from './adapters/pg-model-ledger'
import { PgNoteStore } from './adapters/pg-note-store'
import { PgPostCostReader } from './adapters/pg-post-cost-reader'
import { PgPresenceStore } from './adapters/pg-presence-store'
import { PgProposalStore } from './adapters/pg-proposal-store'
import { PgPushStore } from './adapters/pg-push-store'
import { PgQuestQueue } from './adapters/pg-quest-queue'
import { PgRateLimiter } from './adapters/pg-rate-limiter'
import { PgResearchStore } from './adapters/pg-research-store'
import { PgRiteStore } from './adapters/pg-rite-store'
import { PgRoutingLog } from './adapters/pg-routing-log'
import { PgSealStore } from './adapters/pg-seal-store'
import { PgSecretStore } from './adapters/pg-secret-store'
import { PgStreamTicketStore } from './adapters/pg-stream-ticket-store'
import { PgSuggestionStore } from './adapters/pg-suggestion-store'
import { PgToolsetStore } from './adapters/pg-toolset-store'
import { PgTreasuryStore } from './adapters/pg-treasury-store'
import { PgTripwireStore } from './adapters/pg-tripwire-store'
import { S3ObjectStore } from './adapters/s3-object-store'
import { SystemClock } from './adapters/system-clock'
import { WebPushNotifier } from './adapters/web-push-notifier'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { type AppDeps, createApp } from './app'
import { BugReportService } from './bug-reports'
import { CouncilEngine } from './council'
import { createDb } from './db/client'
import { type DispatchErrorContext, Dispatcher } from './dispatch'
import { DossierService } from './dossiers'
import {
  loadEnv,
  loadInquiryExpiryMs,
  loadPlatformOperators,
  loadResearchEnv,
  loadSandboxEnv,
  loadSandboxStartTimeoutMs,
  loadSubscriptionEnv,
  loadVapidEnv,
  loadWebauthnEnv,
} from './env'
import { Gates } from './gates'
import { isLearningRepoAllowed } from './guild-config'
import { LearningEngine } from './learning-engine'
import { McpGateway } from './mcp/gateway'
import { ModelGateway } from './model-gateway'
import { ProposalEngine } from './proposals'
import { Research } from './research'
import { retireRun } from './retire-run'
import { RiteEngine } from './rites/engine'
import { sandboxRunnerFor } from './sandbox-factory'
import { createSealPushRelay } from './seal-push'
import { SealEngine } from './seals'
import { Summon } from './summon'
import { Treasury } from './treasury'

/** Logs a dispatch failure: a worker-start cleanup or a sandbox reap; ids and the error name only, never content. */
function reportStartCleanup(error: unknown, context: DispatchErrorContext): void {
  const event =
    context.kind === 'sandbox_reap'
      ? 'dispatch.sandbox_reap_failed'
      : 'dispatch.start_cleanup_failed'
  const { kind: _kind, ...ids } = context
  process.stderr.write(
    `${JSON.stringify({ event, ...ids, error: error instanceof Error ? error.name : 'unknown' })}\n`
  )
}

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass a clock, an object store, a KeyProvider and a Db on a
 * throwaway database, production none (the key comes from the local key file). The Db has no memory adapter by design: tenancy is enforced by Postgres, so
 * contract tests run against real Postgres.
 */
export async function compose(
  overrides: Partial<AppDeps> = {}
): Promise<{ app: Hono; adapters: AppDeps }> {
  const { db, devGuildHeader, objectStore, keys, trustProxy, anchor, foundingMode } =
    overrides.db &&
    overrides.devGuildHeader !== undefined &&
    overrides.objectStore &&
    overrides.keys
      ? {
          db: overrides.db,
          devGuildHeader: overrides.devGuildHeader,
          objectStore: overrides.objectStore,
          keys: overrides.keys,
          anchor: overrides.anchor ?? new MemoryCheckpointAnchor(),
          trustProxy: false,
          foundingMode: 'open' as const,
        }
      : await fromEnv(overrides)
  const clock = overrides.clock ?? new SystemClock()
  const rp = loadWebauthnEnv()
  const config = overrides.config ?? new PgConfigStore(db, keys, clock)
  const secrets = overrides.secrets ?? new PgSecretStore(db, keys)
  const notes = overrides.notes ?? new PgNoteStore(db, keys)
  const missives = overrides.missives ?? new PgMissiveStore(db, keys)
  const pgQuests = new PgQuestQueue(db, keys, clock)
  const quests = overrides.quests ?? pgQuests
  const inquiries = overrides.inquiries ?? new PgInquiryStore(db, keys, pgQuests)
  const tripwires = overrides.tripwires ?? new PgTripwireStore(db, keys, clock)
  const gateStore = new PgGateStore(db, keys)
  // Hardened Docker sandboxes when SANDBOX_RUNNER=docker (required in production); memory otherwise.
  const sandboxes = overrides.sandboxes ?? sandboxRunnerFor(loadSandboxEnv())
  const sandboxStartTimeoutMs = loadSandboxStartTimeoutMs()
  const vapid = loadVapidEnv()
  // Subscription providers run the host's own `claude` CLI; off unless the host opts in (ADR-0008).
  const subscriptionEnv = loadSubscriptionEnv()
  const apiModelProvider = overrides.modelProvider ?? new AnthropicModelProvider()
  const subscriptionProvider =
    overrides.subscriptionProvider ??
    (subscriptionEnv.enabled
      ? new ClaudeCliModelProvider({
          bin: subscriptionEnv.bin,
          timeoutMs: subscriptionEnv.timeoutMs,
          maxConcurrent: subscriptionEnv.maxConcurrent,
        })
      : undefined)
  const pushStore = overrides.pushStore ?? new PgPushStore(db)
  // Without VAPID keys (development only; production fails at boot) pushes go to the memory notifier.
  const pushNotifier =
    overrides.pushNotifier ??
    (vapid
      ? new WebPushNotifier({
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
          subject: vapid.subject,
        })
      : new MemoryPushNotifier())
  const identity =
    overrides.identity ??
    new WebAuthnIdentityProvider(new PgIdentityStore(db, keys), {
      clock,
      keys,
      rpId: rp.WEBAUTHN_RP_ID,
      rpName: 'Guildhall',
      origin: rp.WEBAUTHN_ORIGIN,
    })
  const modelLedger = overrides.modelLedger ?? new PgModelLedger(db, keys)
  const sealStore = overrides.sealStore ?? new PgSealStore(db, keys, clock)
  const activity = new PgActivityLog(db, keys)
  const gateway =
    overrides.gateway ??
    new ModelGateway({
      activity,
      ledger: modelLedger,
      secrets,
      config,
      provider: apiModelProvider,
      ...(subscriptionProvider ? { subscriptionProvider } : {}),
      clock,
      quests,
      tripwires,
      gates: gateStore,
    })
  const proposals =
    overrides.proposals ??
    new ProposalEngine({ store: new PgProposalStore(db, keys, clock), config })
  const riteStore = new PgRiteStore(db, keys, clock)
  const charterImports =
    overrides.charterImports ??
    new PgCharterImporter(
      db,
      keys,
      config instanceof PgConfigStore ? config : new PgConfigStore(db, keys, clock),
      riteStore,
      clock
    )
  const handoffs = new PgHandoffStore(db, keys)
  const dossierStore = overrides.dossierStore ?? new PgDossierStore(db, keys)
  const dossiers =
    overrides.dossiers ??
    new DossierService({
      quests,
      handoffs,
      objectStore,
      proposals: new PgProposalStore(db, keys, clock),
      seals: sealStore,
      store: dossierStore,
      clock,
    })
  const bugReportStore = overrides.bugReportStore ?? new PgBugReportStore(db, keys, pgQuests)
  const bugReports =
    overrides.bugReports ??
    new BugReportService({ config, store: bugReportStore, clock, tripwires })
  const treasury =
    overrides.treasury ?? new Treasury({ store: new PgTreasuryStore(db, keys, clock), config })
  // Governed web research is off unless the host configures a search provider (ADR-0010).
  const researchEnv = loadResearchEnv()
  const research = researchEnv
    ? new Research({
        search:
          researchEnv.kind === 'brave'
            ? new BraveSearchProvider({
                apiKey: researchEnv.apiKey,
                privateEligible: researchEnv.privateEligible,
              })
            : new MemorySearchProvider({
                results: researchEnv.seed.results,
                privateEligible: researchEnv.privateEligible,
              }),
        fetcher:
          researchEnv.kind === 'brave'
            ? new HttpPageFetcher()
            : new MemoryPageFetcher(researchEnv.seed.pages),
        store: new PgResearchStore(db),
        treasury,
        config,
        clock,
        costCents: researchEnv.costCents,
      })
    : undefined
  const mcp =
    overrides.mcp ??
    new McpGateway({
      quests,
      config,
      notes,
      missives,
      inquiries,
      inquiryExpiryMs: loadInquiryExpiryMs(),
      objectStore,
      handoffs,
      ...(research ? { research } : {}),
      dossiers,
      bugReports,
      bugReportStore,
      activity,
      toolsets: new PgToolsetStore(db),
      proposals,
      rites: riteStore,
      keys,
      clock,
      tripwires,
      gates: gateStore,
      retireRun: retireRun({ runs: gateway, sandboxes }),
    })
  const seals = overrides.seals ?? new SealEngine({ store: sealStore, config, identity })
  // The model classifier runs only on a private-eligible provider's cheap tier (ADR-0006, ADR-0012),
  // re-read from config on every call; otherwise the deterministic stand-in answers (private).
  const classifier =
    overrides.classifier ??
    new BoundClassifier({ config, gateway, standin: new MemoryClassifier() })
  const routingLog = overrides.routingLog ?? new PgRoutingLog(db)
  const presence = overrides.presence ?? new PgPresenceStore(db, keys, clock)
  const councilStore = overrides.councilStore ?? new PgCouncilStore(db, keys)
  const council =
    overrides.council ??
    new CouncilEngine({
      store: councilStore,
      model: gateway,
      clock,
      gates: gateStore,
      config,
      presence,
    })
  const adapters: AppDeps = {
    ...overrides,
    ...(research ? { research } : {}),
    subscriptionEnabled: subscriptionProvider !== undefined,
    providerVendors: [
      apiModelProvider.vendor,
      ...(subscriptionProvider ? [subscriptionProvider.vendor] : []),
    ],
    guildMasterLooks: overrides.guildMasterLooks ?? new PgGuildMasterLookStore(db),
    presence,
    councilStore,
    council,
    pushStore,
    pushNotifier,
    pushRelay:
      overrides.pushRelay ??
      createSealPushRelay({ db, store: pushStore, notifier: pushNotifier, clock }),
    vapidPublicKey: overrides.vapidPublicKey ?? vapid?.publicKey ?? null,
    clock,
    db,
    devGuildHeader,
    objectStore,
    identity,
    keys,
    anchor,
    rateLimiter: overrides.rateLimiter ?? new PgRateLimiter(db, clock),
    trustProxy: overrides.trustProxy ?? trustProxy,
    foundingMode: overrides.foundingMode ?? foundingMode,
    config,
    seals,
    sealStore,
    modelLedger,
    postCosts: new PgPostCostReader(db),
    secrets,
    proposals,
    rites:
      overrides.rites ??
      new RiteEngine({
        store: riteStore,
        config,
        quests,
        tripwires,
        proposals,
        seals: sealStore,
        handoffs,
      }),
    charterImports,
    notes,
    missives,
    inquiries,
    dossiers,
    dossierStore,
    bugReports,
    bugReportStore,
    quests,
    mcp,
    tripwires,
    treasury,
    // The read-only Envoy resolves the GitHub token from the Vault per call and reads only repos on
    // the guild's own config allowlist; the check runs before any request.
    learning:
      overrides.learning ??
      new LearningEngine({
        store: overrides.suggestions ?? new PgSuggestionStore(db, keys, clock),
        envoy:
          overrides.githubEnvoy ??
          new GitHubRestEnvoy({
            secrets,
            isAllowed: async (guildId, repo) =>
              isLearningRepoAllowed((await config.current(guildId)).config, repo),
          }),
        config,
        notes,
        gates: gateStore,
        clock,
      }),
    streamTickets: overrides.streamTickets ?? new PgStreamTicketStore(db, clock),
    classifier,
    routingLog,
    dispatcher:
      overrides.dispatcher ??
      new Dispatcher({
        config,
        quests,
        sealStore,
        awaiting: new PgAwaitingSealReader(db, clock),
        presence,
        council,
        proposals,
        seals,
        routing: { classifier, log: routingLog, keys },
        ledger: modelLedger,
        tripwires,
        clock,
        random: Math.random,
        // Routing skips `subscription` providers unless the host enabled them; hosted (v2) never does.
        hosted: subscriptionProvider === undefined,
        gates: gateStore,
        gateway,
        mcp,
        sandboxes,
        sandboxStartTimeoutMs,
        onError: reportStartCleanup,
      }),
    gateway,
    sandboxes,
    summon:
      overrides.summon ??
      new Summon({
        config,
        quests,
        tripwires,
        gates: gateStore,
        gateway,
        mcp,
        sandboxes,
        sandboxStartTimeoutMs,
        onError: reportStartCleanup,
        clock,
        subscriptionEnabled: subscriptionProvider !== undefined,
      }),
    platformOperators: overrides.platformOperators ?? loadPlatformOperators(),
    gates:
      overrides.gates ??
      new Gates({
        store: gateStore,
        runs: gateway,
        sandboxes,
        quests,
        guildIds: (after, limit) => db.guildIds(after, limit),
      }),
  }
  return { app: createApp(adapters), adapters }
}

async function fromEnv(
  overrides: Partial<AppDeps>
): Promise<
  Required<
    Pick<
      AppDeps,
      'db' | 'devGuildHeader' | 'objectStore' | 'keys' | 'trustProxy' | 'anchor' | 'foundingMode'
    >
  >
> {
  const env = loadEnv()
  return {
    keys:
      overrides.keys ??
      (await FileKeyProvider.open(env.KEY_FILE, { create: env.NODE_ENV !== 'production' })),
    anchor: overrides.anchor ?? new FileCheckpointAnchor(env.CHECKPOINT_DIR),
    db: overrides.db ?? createDb(env.APP_DATABASE_URL),
    devGuildHeader: overrides.devGuildHeader ?? env.DEV_GUILD_HEADER,
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY,
    foundingMode: overrides.foundingMode ?? env.FOUNDING_MODE,
    objectStore:
      overrides.objectStore ??
      new S3ObjectStore({
        endpoint: env.OBJECT_STORE_ENDPOINT,
        bucket: env.OBJECT_STORE_BUCKET,
        accessKeyId: env.OBJECT_STORE_ACCESS_KEY,
        secretAccessKey: env.OBJECT_STORE_SECRET_KEY,
      }),
  }
}
