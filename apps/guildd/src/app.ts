import { type Context, Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import { ARCHIVE_EVENT } from './archive-export/events'
import { mountArchiveExportRoutes } from './archive-export/routes'
import {
  checkpointHash,
  InvalidCursorError,
  MAX_VERIFY_ENTRIES,
  signCheckpoint,
  verifyChain,
  verifyFrom,
} from './audit-chain'
import { awayDigest, MAX_DIGEST_PAGE } from './away-digest'
import type { BugReportService } from './bug-reports'
import { CHARTER_EVENT } from './charters/events'
import { mountCharterRoutes } from './charters/routes'
import { costPerPost } from './cost-per-post'
import type { CouncilEngine } from './council'
import { type Db, FoundingClosedError } from './db/client'
import type { Dispatcher } from './dispatch'
import type { DossierService } from './dossiers'
import { createEventHub } from './event-hub'
import { appendEvent, type EventBound, eventsHistory, headSeq } from './events'
import type { Gates } from './gates'
import { type GuildConfig, guildConfig, guildTripwires, lockedHallIds } from './guild-config'
import { assertFinishBody, registerFinishBody } from './identity-schemas'
import { GatesBarredError, type LearningEngine } from './learning-engine'
import { characterLook } from './look-catalogue'
import type { McpGateway } from './mcp/gateway'
import { GatewayError, gatewayCall, type ModelGateway } from './model-gateway'
import {
  BUG_REPORT_STATUSES,
  type BugReportStore,
  fileBugReportInput,
  MAX_BUG_REPORT_PAGE,
} from './ports/bug-report-store'
import type { CharterImporter } from './ports/charter-import'
import type { CheckpointAnchor } from './ports/checkpoint-anchor'
import type { Classifier } from './ports/classifier'
import type { Clock } from './ports/clock'
import { ConfigError, type ConfigStore, MAX_CONFIG_PAGE } from './ports/config-store'
import { type CouncilStore, MAX_COUNCIL_PAGE } from './ports/council-store'
import { type DossierStore, MAX_DOSSIER_PAGE } from './ports/dossier-store'
import type { GitHubEnvoy } from './ports/github-envoy'
import type { GuildMasterLookStore } from './ports/guild-master-look-store'
import { IdentityError, type IdentityProvider, type IdentitySession } from './ports/identity'
import { type InquiryStore, MAX_INQUIRY_PAGE } from './ports/inquiry-store'
import type { KeyProvider } from './ports/key-provider'
import { MAX_MISSIVE_PAGE, type MissiveStore } from './ports/missive-store'
import type { ModelLedger } from './ports/model-ledger'
import { isUsageDate, MAX_USAGE_PAGE, usageGroup } from './ports/model-ledger'
import type { ModelProvider } from './ports/model-provider'
import { MAX_NOTE_PAGE, NoteError, type NoteStore, newNote, noteFields } from './ports/note-store'
import type { ObjectStore } from './ports/object-store'
import type { PostCostReader } from './ports/post-cost-reader'
import { isAway, type PresenceState, type PresenceStore } from './ports/presence-store'
import { MAX_PROPOSAL_PAGE } from './ports/proposal-store'
import type { PushNotifier } from './ports/push-notifier'
import type { PushStore } from './ports/push-store'
import { MAX_QUEST_PAGE, type QuestQueue, questState } from './ports/quest-queue'
import type { RateLimiter } from './ports/rate-limiter'
import type { BlockReason, RoutingLog } from './ports/routing-log'
import type { SandboxRunner } from './ports/sandbox-runner'
import type { SealStore } from './ports/seal-store'
import { actionHash, MAX_SEAL_PAGE, SEAL_STATUSES, type SealRefusal } from './ports/seal-store'
import {
  MAX_SECRET_PAGE,
  SecretExistsError,
  type SecretStore,
  secretRef,
  secretValue,
} from './ports/secret-store'
import type { StreamTicketStore } from './ports/stream-ticket'
import { MAX_SUGGESTION_PAGE, type SuggestionStore } from './ports/suggestion-store'
import { MAX_TREASURY_PAGE, type TreasuryRefusal } from './ports/treasury-store'
import { MAX_TRIPWIRE_PAGE, type TripwireStore } from './ports/tripwire-store'
import type { ProposalEngine } from './proposals'
import { isPushEndpoint, PUSH_SERVICE_HOSTS } from './push-endpoint'
import { postQuest, postQuestInput } from './quests'
import { DEFAULT_RATE_LIMITS, type RateLimits, rateLimit } from './rate-limits'
import { readCapped } from './read-capped'
import type { Research } from './research'
import type { RiteEngine } from './rites/engine'
import { mountRiteRoutes } from './rites/routes'
import type { SealPushRelay } from './seal-push'
import type { SealEngine } from './seals'
import { bearerToken, checkSensitive, REAUTH_HEADER } from './sensitive'
import {
  clearedSessionCookie,
  cookieModeAllowed,
  sessionCookie,
  sessionCookieAuth,
  sessionHeaders,
  sessionTokenOf,
  wantsCookie,
} from './session-cookie'
import type { Summon } from './summon'
import { startTeamCampaign, startTeamCampaignInput } from './team-campaign'
import { isGuildMaster, type Treasury } from './treasury'
import { readBufferedAmount } from './ws-support'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
  objectStore: ObjectStore
  identity: IdentityProvider
  /** Custody of the audit chain's MAC key; never the database. */
  keys: KeyProvider
  /** Signed chain-head checkpoints kept outside Postgres; what makes tail truncation detectable. */
  anchor: CheckpointAnchor
  /** The Vault: envelope-encrypted provider keys; values leave only through internal `resolve`. */
  secrets: SecretStore
  /** Versioned guild config: Halls, roster, Seal Policy, caps; widening changes wait for re-auth. */
  config: ConfigStore
  /** The Archive: notes with version history, backlinks and full-text search. */
  notes: NoteStore
  /** Missives between the Members of a Hall, read by the Guild Master in the ledger. */
  missives: MissiveStore
  /** Inquiries between Halls, listed and read by the Guild Master. */
  inquiries: InquiryStore
  /** Dossiers: assembles verified packets about finished Quests; the Guild Master creates and reads them. */
  dossiers: DossierService
  /** The stored Dossiers, listed per Hall and read by id. */
  dossierStore: DossierStore
  /** Bug Reports: files one and posts its Fix Quest; the Guild Master files and reads them. */
  bugReports: BugReportService
  /** The stored Bug Reports, listed per Hall and read by id. */
  bugReportStore: BugReportStore
  /** Seals: the engine Quests call to request a Seal; the Guild Master decides in the Seal inbox. */
  seals: SealEngine
  /** Proposals: drafted content bound to its hash, with the deterministic Verdict bound to the same hash. */
  proposals: ProposalEngine
  /** Versioned Rites and their instances; compiles agent nodes to governed Quests, with no authority of its own. */
  rites: RiteEngine
  /** Charter import: config proposal, Rite drafts, event and idempotency record in one transaction. */
  charterImports: CharterImporter
  /** The Quest queue: Quests, leases, retries and the dead-letter list. */
  quests: QuestQueue
  /** The stateless MCP gateway Members call with a lease handle; authorises every call itself. */
  mcp: McpGateway
  /** Single-use tickets that authorise one event-stream WebSocket (browsers cannot send headers). */
  streamTickets: StreamTicketStore
  /** Routing step 1 for free-text goals; the deterministic adapter until a cheap model is wired. */
  classifier: Classifier
  /** Routing decision log (insert-only), read by the future Oracle. */
  routingLog: RoutingLog
  /** The model gateway: per-run tokens, metering and caps in front of the model providers. */
  gateway: ModelGateway
  /** Composition-only: governed web research, swept by the dispatch loop; absent when no provider is configured. */
  research?: Research
  /** Composition-only: the model provider the gateway wraps (Anthropic API key by default). */
  modelProvider?: ModelProvider
  /** Serves `subscription` providers; tests inject a memory one, production the `claude` CLI adapter. */
  subscriptionProvider?: ModelProvider
  /** Whether the host enabled `subscription` providers; a config naming one is refused otherwise. */
  subscriptionEnabled?: boolean
  /** The vendor each bound model provider adapter declares; the private-work disclosure names it. */
  providerVendors?: readonly string[]
  /** Member ids (env `PLATFORM_OPERATORS`) who may bar or lift every guild; read per request. */
  platformOperators: readonly string[]
  /** Bar the Gates: the kill switch for one guild or all, and the sandboxes it stops. */
  gates: Gates
  /** The isolated worker that runs Quest code; Bar the Gates kills its sandboxes. */
  sandboxes: SandboxRunner
  /** "Summon your first member": the test Quest that proves the worker and provider run end to end. */
  summon: Summon
  /** The dispatcher: claims, routes and starts one Quest per pass; reached by the route and the job hook. */
  dispatcher: Dispatcher
  /** The Seal store, read by the dispatcher to reconcile Quests with their Seals. */
  sealStore: SealStore
  /** Cost per accepted post, read as one aggregate. */
  postCosts: PostCostReader
  /** The model ledger: per-run metering, the source of usage reports and cost per post. */
  modelLedger: ModelLedger
  /** Hall pauses: what a Tripwire (or the Guild Master) pauses; paused Halls take and start no Quests. */
  tripwires: TripwireStore
  /** The Guild Master's push subscriptions, delivery claims and dispatch cursors. */
  pushStore: PushStore
  /** The Guild Master's saved character look, the same on every device. */
  guildMasterLooks: GuildMasterLookStore
  /** The Guild Master's presence (away mode); the Council reads it through `isAway`. */
  presence: PresenceStore
  /** The Council of Elders' sessions and votes. */
  councilStore: CouncilStore
  /** The Council of Elders: convened by the Seal step on routine Proposals while the Guild Master is away. */
  council: CouncilEngine
  /** Sends a web push to one device; the memory adapter in development without VAPID keys. */
  pushNotifier: PushNotifier
  /** Pushes the Guild Master's devices when a Seal is requested; started by `main`. */
  pushRelay: SealPushRelay
  /** Push service hosts a subscription may name; tests only, production uses the fixed list. */
  pushAllowedHosts?: readonly string[]
  /** VAPID public key a browser subscribes with, or null when push is not configured. */
  vapidPublicKey: string | null
  /**
   * The paper Treasury: deterministic spend rules and an append-only chained ledger. Only routes
   * reach it (writes need a session, approvals re-authentication); no agent-facing tool does.
   */
  treasury: Treasury
  /**
   * Weekly learning suggestions from allowlisted repos. Only routes (a Guild Master session) and a
   * Schedule reach it; it never calls a model.
   */
  learning: LearningEngine
  /** Composition-only: the read-only GitHub Envoy the learning engine reads through. */
  githubEnvoy?: GitHubEnvoy
  /** Composition-only: where suggested learnings are kept. */
  suggestions?: SuggestionStore
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
  /** Abuse limits for the unauthenticated identity routes; state is shared, never in process memory. */
  rateLimiter: RateLimiter
  /** Read the client address from the last `X-Forwarded-For` hop (env `TRUST_PROXY`); default false. */
  trustProxy?: boolean
  /** Who may found a guild (env `FOUNDING_MODE`): `open` (default), `once` or `closed`. */
  foundingMode?: 'open' | 'once' | 'closed'
  /** Per-route limit overrides; defaults to {@link DEFAULT_RATE_LIMITS}. */
  rateLimits?: Partial<RateLimits>
  /** Milliseconds between fallback polls for missed notifications; defaults to 5000. */
  eventPollMs?: number
  /** Milliseconds before an ObjectStore call is abandoned with a 504; defaults to 10000. */
  objectStoreTimeoutMs?: number
  /** Largest accepted artifact in bytes; defaults to {@link MAX_ARTIFACT_BYTES}. */
  maxArtifactBytes?: number
  /** Live event sockets allowed per guild; defaults to 8. */
  maxSocketsPerGuild?: number
  /** A socket buffering more than this many bytes is closed; defaults to 1 MiB. */
  maxSocketBufferBytes?: number
}

const { upgradeWebSocket, websocket } = createBunWebSocket()

/** The Bun websocket handler; pass it to `Bun.serve` next to the app's `fetch`. */
export { websocket }

const foundFinishBody = registerFinishBody.extend({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(2000),
})
const _foundGuildBody = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(2000),
})

/** Bytes in the base64url string, or -1 when it is not base64url. */
function base64urlLength(value: string): number {
  return /^[A-Za-z0-9_-]+$/.test(value) ? Buffer.from(value, 'base64url').length : -1
}

/** The device keys a browser's PushSubscription carries: a P-256 point and a 16-byte secret. */
const pushKeys = z.object({
  p256dh: z
    .string()
    .refine((v) => base64urlLength(v) === 65 && Buffer.from(v, 'base64url')[0] === 4),
  auth: z.string().refine((v) => base64urlLength(v) === 16),
})
const pushSubscribeBody = z.object({ endpoint: z.string().max(2048), keys: pushKeys })
const pushUnsubscribeBody = z.object({ endpoint: z.string().max(2048) })

const uuid = z.uuid()
const verifyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_VERIFY_ENTRIES).optional(),
  cursor: z.string().max(300).optional(),
  full: z.enum(['true', 'false']).optional(),
})
const checkpointBeginBody = z.object({
  limit: z.number().int().min(1).max(MAX_VERIFY_ENTRIES).optional(),
})
const desktopBeginBody = z.object({ state: z.string().min(22).max(200) })
// A missing state is not a malformed request: it fails like a wrong one.
const desktopExchangeBody = z.object({
  code: z.string().min(1).max(200),
  state: z.string().max(200).default(''),
})

const checkpointFinishBody = assertFinishBody.extend({
  seq: z.number().int().min(1),
  mac: z.string().regex(/^[0-9a-f]{64}$/),
  limit: z.number().int().min(1).max(MAX_VERIFY_ENTRIES).optional(),
})
/** Largest accepted request body for adding a secret. */
const MAX_SECRET_REQUEST_BYTES = 16 * 1024
const addSecretBody = z.object({ ref: secretRef, value: secretValue })
const checkSecretsBody = z.object({ refs: z.array(secretRef).min(1).max(MAX_SECRET_PAGE) })
const secretPage = z.object({
  after: secretRef.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SECRET_PAGE).default(50),
})
const notePage = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_NOTE_PAGE).default(50),
  q: z.string().max(500).optional(),
})
const missivePage = z.object({
  after: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_MISSIVE_PAGE).default(50),
})
const digestPage = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_DIGEST_PAGE).default(50),
})
const councilPage = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_COUNCIL_PAGE).default(20),
})
const dossierPage = z.object({
  after: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DOSSIER_PAGE).default(50),
})
const createDossierInput = z.strictObject({ questId: uuid })
const bugReportPage = z.object({
  after: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_BUG_REPORT_PAGE).default(50),
  status: z.enum(BUG_REPORT_STATUSES).optional(),
})
const inquiryPage = z.object({
  after: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_INQUIRY_PAGE).default(50),
})
const sealPage = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEAL_PAGE).default(50),
  status: z.enum(SEAL_STATUSES).optional(),
})
const proposalPage = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PROPOSAL_PAGE).default(50),
})
const proposalBody = z.object({
  questId: uuid,
  author: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(100),
  content: z.string().min(1).max(20000),
})
const sealDecisionBody = z.object({
  actionHash,
  note: z.string().trim().min(1).max(2000).optional(),
})
const sealPostedBody = z.object({ text: z.string().min(1).max(20000) })
const treasuryPage = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TREASURY_PAGE).default(50),
})
const idempotencyKey = z.string().trim().min(1).max(200)
const cents = z.number().int().min(1).max(100_000_000)
const revenueBody = z.object({
  key: idempotencyKey,
  amountCents: cents,
  evidence: z.string().max(2000),
})
const spendRequestBody = z.object({
  key: idempotencyKey,
  amountCents: cents,
  purpose: z.string().trim().min(1).max(2000),
})
const settleBody = z.object({ actualCents: z.number().int().min(0).max(100_000_000) })
const reserveReleaseBody = z.object({ key: idempotencyKey, amountCents: cents })
const hallParam = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const pausePage = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TRIPWIRE_PAGE).default(50),
})
const questPage = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_QUEST_PAGE).default(50),
  state: questState.optional(),
})
const historyQuery = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  until: z
    .string()
    .refine((v) => /^\d{1,15}$/.test(v) || !Number.isNaN(Date.parse(v)))
    .optional(),
})
const usageQuery = z.object({
  by: usageGroup,
  after: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USAGE_PAGE).default(50),
})
const costPerPostQuery = z.object({
  after: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USAGE_PAGE).default(50),
})
/** HTTP status for a refused gateway call. */
function gatewayStatus(code: GatewayError['code']): 400 | 401 | 409 | 429 | 502 {
  switch (code) {
    case 'invalid_request':
      return 400
    case 'invalid_token':
    case 'token_expired':
    case 'token_revoked':
      return 401
    case 'cap_reached':
    case 'subscription_limit':
      return 429
    case 'provider_failed':
      return 502
    default:
      return 409
  }
}
const summonBody = z.object({ profileId: z.string().min(1).max(64) })
const putConfigBody = z.object({
  config: guildConfig,
  /** The config version the caller read; the save is refused as `stale` if it is no longer in force. */
  baseVersion: z.number().int().min(1),
})
/** The most unknown config key names one 422 refusal echoes back. */
const MAX_UNKNOWN_KEYS_LISTED = 20
/** The longest an echoed unknown config key may be, counting the ellipsis that marks a cut. */
export const MAX_UNKNOWN_KEY_LENGTH = 64
/**
 * An unknown key cut to MAX_UNKNOWN_KEY_LENGTH UTF-16 units with an ellipsis, never leaving half of a
 * surrogate pair at the cut.
 */
function shortenUnknownKey(key: string): string {
  if (key.length <= MAX_UNKNOWN_KEY_LENGTH) {
    return key
  }
  const cut = key.slice(0, MAX_UNKNOWN_KEY_LENGTH - 1)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}
const configVersion = z.coerce.number().int().min(1).max(2_147_483_647)
const versionPage = z.object({
  after: configVersion.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONFIG_PAGE).default(50),
})
const rosterPage = z.object({
  after: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONFIG_PAGE).default(50),
})
const artifactClass = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const artifactHash = z.string().regex(/^[0-9a-f]{64}$/)
/** Default artifact size cap; main.ts sizes Bun's request-body limit from it. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Thrown when an ObjectStore call outlives its timeout. */
class StoreTimeoutError extends Error {}

/**
 * The titles of the guild's Quests by id, read one at a time through the guild-scoped queue (so a
 * Quest of another guild reads as missing). Ids that are not uuids and unknown Quests are left out.
 */
async function questTitles(
  quests: Pick<QuestQueue, 'get'>,
  guildId: string,
  questIds: Iterable<string | null>
): Promise<Map<string, string>> {
  const ids = [...new Set(questIds)].filter(
    (id): id is string => id !== null && uuid.safeParse(id).success
  )
  const found = await Promise.all(ids.map((id) => quests.get(guildId, id)))
  const titles = new Map<string, string>()
  for (const quest of found) {
    if (quest) {
      titles.set(quest.id, quest.title)
    }
  }
  return titles
}

/** Builds the guildd HTTP app over the given adapters. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  app.use('*', sessionCookieAuth(deps.trustProxy ?? false))
  // Releases a reserved stream slot once the socket opens; keyed by the upgrade request.
  const streamSlots = new WeakMap<Request, () => void>()
  const maxBytes = deps.maxArtifactBytes ?? MAX_ARTIFACT_BYTES
  const storeTimeoutMs = deps.objectStoreTimeoutMs ?? 10_000

  /** Bounds an ObjectStore call so a stalled backend cannot hold a request open. */
  function withStoreTimeout<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeoutError()), storeTimeoutMs)
    })
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
  }
  app.onError((err, c) => {
    if (err instanceof StoreTimeoutError) {
      return c.json({ error: 'object_store_timeout' }, 504)
    }
    if (err instanceof IdentityError) {
      const status =
        err.code === 'invalid_challenge' ? 400 : err.code === 'credential_exists' ? 409 : 401
      return c.json({ error: err.code }, status)
    }
    return c.json({ error: 'internal_error' }, 500)
  })
  const hub = createEventHub(deps.db, {
    pollMs: deps.eventPollMs,
    maxSocketsPerGuild: deps.maxSocketsPerGuild,
    maxBufferedBytes: deps.maxSocketBufferBytes,
  })
  app.get('/health', (c) => c.json({ status: 'ok', time: deps.clock.now().toISOString() }))

  // Unauthenticated identity routes are rate limited per client and per guild (429 + Retry-After).
  const limitsOf = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits }
  const limited = (route: keyof RateLimits) =>
    rateLimit(deps.rateLimiter, route, limitsOf[route], deps.trustProxy ?? false, callerGuild)
  /**
   * Charges the per-guild bucket of a token-bearing route to the guild its already verified token
   * names (all sandboxes share the proxy's address, so the client bucket cannot tell them apart).
   * Returns the 429 when the bucket is spent.
   */
  const chargeTokenGuild = async (
    c: Context,
    route: 'gateway-call' | 'mcp',
    guild: string | null
  ): Promise<Response | null> => {
    const rule = limitsOf[route].guild
    if (!guild || !rule) {
      return null
    }
    const decision = await deps.rateLimiter.hit(`${route}:guild:${guild}`, rule)
    if (decision.allowed) {
      return null
    }
    c.header('Retry-After', String(decision.retryAfterSeconds))
    return c.json({ error: 'rate_limited' }, 429)
  }
  app.post('/founding/begin', limited('founding-begin'))
  app.post('/founding/finish', limited('founding'))
  app.get('/founding', limited('founding-status'))
  app.post('/sign-in/begin', limited('signin-begin'))
  app.post('/sign-in/finish', limited('signin-finish'))
  app.post('/guilds/:id/passkeys/begin', limited('passkeys-begin'))
  app.post('/guilds/:id/passkeys/finish', limited('passkeys-finish'))
  app.post('/guilds/:id/enrol/begin', limited('enrol-begin'))
  app.post('/guilds/:id/enrol/finish', limited('enrol-finish'))
  app.post('/auth/desktop/begin', limited('desktop-begin'))
  app.post('/auth/desktop/exchange', limited('desktop-exchange'))
  app.post('/guilds/:id/sign-in/begin', limited('signin-begin'))
  app.post('/guilds/:id/sign-in/finish', limited('signin-finish'))
  app.post('/guilds/:id/events/ticket', limited('stream-ticket'))
  app.post('/guilds/:id/push/subscriptions', limited('push-subscribe'))
  app.delete('/guilds/:id/push/subscriptions', limited('push-subscribe'))
  app.post('/guilds/:id/audit/checkpoints/begin', limited('checkpoint-begin'))
  app.post('/guilds/:id/audit/checkpoints/finish', limited('checkpoint-finish'))
  // Token-bearing, not session-bearing, and there is no guild in the path: client bucket only.
  app.post('/gateway/complete', limited('gateway-call'))
  app.post('/guilds/:id/quests', limited('quest-post'))
  app.post('/guilds/:id/campaigns/team', limited('quest-post'))
  app.post('/guilds/:id/summon', limited('summon'))
  app.post('/guilds/:id/dispatch', limited('dispatch'))
  app.get('/guilds/:id/cost-per-post', limited('cost-per-post'))
  app.get('/guilds/:id/summon', limited('summon-status'))
  app.post('/guilds/:id/seals/:sealId/posted', limited('seal-posted'))
  app.post('/mcp', limited('mcp'))
  app.post('/guilds/:id/proposals', limited('proposal-post'))
  app.post('/guilds/:id/learning/scan', limited('learning-scan'))
  app.get('/guilds/:id/events/history', limited('events-history'))
  app.get('/guilds/:id/halls/:hallId/missives', limited('missives-read'))
  app.get('/guilds/:id/halls/:hallId/inquiries', limited('missives-read'))
  app.get('/guilds/:id/inquiries/:inquiryId', limited('missives-read'))
  app.get('/guilds/:id/halls/:hallId/dossiers', limited('dossier-read'))
  app.get('/guilds/:id/dossiers/:dossierId', limited('dossier-read'))
  app.get('/guilds/:id/council/sessions', limited('dossier-read'))
  app.get('/guilds/:id/guild-master/away-digest', limited('dossier-read'))
  app.post('/guilds/:id/dossiers', limited('dossier-write'))
  app.get('/guilds/:id/halls/:hallId/bug-reports', limited('bug-report-read'))
  app.get('/guilds/:id/bug-reports/:reportId', limited('bug-report-read'))
  app.post('/guilds/:id/bug-reports', limited('bug-report-write'))
  app.get('/guilds/:id/guild-master/presence', limited('presence-read'))
  app.post('/guilds/:id/guild-master/away', limited('presence-write'))
  app.post('/guilds/:id/guild-master/return', limited('presence-write'))
  app.get('/guilds/:id/charter', limited('rite-read'))
  app.post('/guilds/:id/charter/preview', limited('rite-read'))
  app.post('/guilds/:id/charter/import', limited('rite-write'))
  app.get('/guilds/:id/archive/export', limited('archive-export'))
  app.get('/guilds/:id/rites', limited('rite-read'))
  app.get('/guilds/:id/rites/:riteId', limited('rite-read'))
  app.get('/guilds/:id/rites/:riteId/versions', limited('rite-read'))
  app.get('/guilds/:id/rites/:riteId/runs', limited('rite-read'))
  app.get('/guilds/:id/rites/:riteId/runs/:runId', limited('rite-read'))
  app.put('/guilds/:id/rites/:riteId', limited('rite-write'))
  app.post('/guilds/:id/rites/:riteId/validate', limited('rite-write'))
  app.post('/guilds/:id/rites/:riteId/versions/:version/confirm', limited('rite-write'))
  app.post('/guilds/:id/rites/:riteId/runs', limited('rite-run'))
  app.get('/session', limited('session-check'))
  app.post('/session/logout', limited('session-check'))
  app.post('/session/reauth/begin', limited('reauth'))
  app.post('/session/reauth/finish', limited('reauth'))

  // The MCP gateway is stateless and authorises each call by the signed lease handle in its
  // arguments; the guild is derived from that token, never taken from the path, a header or the body.
  app.post('/mcp', async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    const spent = await chargeTokenGuild(c, 'mcp', await deps.mcp.verifiedGuild(raw))
    if (spent) {
      return spent
    }
    const reply = await deps.mcp.handle(raw)
    if (reply.body === null) {
      return c.body(null, 202)
    }
    return c.json(reply.body, reply.status)
  })

  // Whether the web app should offer "Found your guild": a boolean only, nothing about any guild.
  app.get('/founding', async (c) => {
    const mode = deps.foundingMode ?? 'open'
    const open = mode === 'open' || (mode === 'once' && !(await deps.db.anyGuildExists()))
    return c.json({ open })
  })

  // Founding as one ceremony: nothing is written for the guild until the first passkey verifies,
  // then the guild, its Guild Master, its seeded Halls and the passkey commit in ONE transaction.
  app.post('/founding/begin', async (c) => {
    if ((deps.foundingMode ?? 'open') === 'closed') {
      return c.json({ error: 'founding_closed' }, 403)
    }
    return c.json(await deps.identity.beginFounding())
  })

  app.post('/founding/finish', async (c) => {
    const body = foundFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const mode = deps.foundingMode ?? 'open'
    if (mode === 'closed') {
      return c.json({ error: 'founding_closed' }, 403)
    }
    try {
      const { guildId } = await deps.identity.finishFounding(
        body.data.challengeId,
        body.data.response,
        (write) =>
          deps.db.foundGuildChained(
            { name: body.data.name, goal: body.data.goal },
            deps.keys,
            async (tx, id) => {
              await deps.config.seed(id, tx)
              await write(tx, id)
            },
            { once: mode === 'once' }
          )
      )
      return c.json({ id: guildId }, 201)
    } catch (error) {
      if (error instanceof FoundingClosedError) {
        return c.json({ error: 'founding_closed' }, 403)
      }
      throw error
    }
  })

  /**
   * The single trust boundary: which guild is calling. A Bearer session token (passkey sign-in)
   * names the guild; otherwise it is the `x-guild-id` header, honoured only when DEV_GUILD_HEADER is on; otherwise no caller.
   */
  async function callerGuild(c: Context): Promise<string | null> {
    const token = sessionTokenOf(c)
    if (token) {
      return (await deps.identity.resolveSession(token))?.guildId ?? null
    }
    if (!deps.devGuildHeader) {
      return null
    }
    const parsed = uuid.safeParse(c.req.header('x-guild-id'))
    return parsed.success ? parsed.data : null
  }

  /**
   * A single-use `?ticket=` on a WebSocket upgrade request from a browser, which cannot set an
   * Authorization header (see `POST /guilds/:id/events/ticket`). Not spent here: the stream route
   * spends it after reserving a slot. A session token in the URL is never accepted.
   */
  function presentedTicket(c: Context): { guild: string; ticket: string } | null {
    const ticket = c.req.query('ticket')
    const guild = uuid.safeParse(c.req.param('id'))
    if (!ticket || !guild.success || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return null
    }
    return { guild: guild.data, ticket }
  }

  /** Whether the guild exists (the guild row is visible only under its own tenant context). */
  async function guildExists(id: string): Promise<boolean> {
    const rows = await deps.db.withGuild(
      id,
      (tx) => tx`select 1 from guilds where guild_id = ${id}`
    )
    return rows.length > 0
  }

  /** Parses `:id` as a guild that exists, else null (caller answers 404). */
  async function ceremonyGuild(c: Context): Promise<string | null> {
    const id = uuid.safeParse(c.req.param('id'))
    return id.success && (await guildExists(id.data)) ? id.data : null
  }

  // Passkeys. The first passkey of a guild is open (founding); adding another is a sensitive
  // action: a session of that guild plus a fresh re-authentication proof.
  app.post('/guilds/:id/passkeys/begin', async (c) => {
    const guild = await ceremonyGuild(c)
    if (!guild) {
      return c.json({ error: 'not_found' }, 404)
    }
    const token = sessionTokenOf(c)
    const foundingToken = c.req.header('x-founding-token')
    if (await deps.identity.hasCredentials(guild)) {
      const check = await checkSensitive(deps.identity, sessionHeaders(c))
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      if (check.guildId !== guild) {
        return c.json({ error: 'not_found' }, 404)
      }
    }
    return c.json(
      await deps.identity.beginRegistration(guild, {
        ...(token ? { sessionToken: token } : {}),
        ...(foundingToken ? { foundingToken } : {}),
      })
    )
  })

  app.post('/guilds/:id/passkeys/finish', async (c) => {
    const guild = await ceremonyGuild(c)
    const body = registerFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!guild) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const sessionToken = sessionTokenOf(c)
    return c.json(
      await deps.identity.finishRegistration(
        guild,
        body.data.challengeId,
        body.data.response,
        sessionToken ? { sessionToken } : {}
      ),
      201
    )
  })

  // Enrolling a passkey on a new device with a one-time token minted on the host (never over
  // HTTP). Every failure is one refusal: an unknown guild, a missing, wrong, expired, spent or
  // other-guild token all answer 401 registration_closed.
  app.post('/guilds/:id/enrol/begin', async (c) => {
    const guild = uuid.safeParse(c.req.param('id'))
    const token = c.req.header('x-enrol-token')
    if (!guild.success || !token) {
      throw new IdentityError('registration_closed')
    }
    return c.json(await deps.identity.beginEnrolment(guild.data, token))
  })

  app.post('/guilds/:id/enrol/finish', async (c) => {
    if (wantsCookie(c) && !cookieModeAllowed(c)) {
      return c.json({ error: 'csrf_refused' }, 403)
    }
    const guild = uuid.safeParse(c.req.param('id'))
    const body = registerFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (!guild.success) {
      throw new IdentityError('registration_closed')
    }
    const session = await deps.identity.finishEnrolment(
      guild.data,
      body.data.challengeId,
      body.data.response
    )
    return sessionResponse(c, session, 201)
  })

  // Hand-off of a browser sign-in to the desktop shell (docs/spikes/tauri-passkeys.md, path b).
  // A signed-in session mints a single-use code (60 s); the shell exchanges it for its own session.
  app.post('/auth/desktop/begin', async (c) => {
    const token = sessionTokenOf(c)
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const body = desktopBeginBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json(await deps.identity.beginDesktopHandoff(token, body.data.state), 201)
  })

  // Every failure is one refusal: a wrong, expired, spent or other-guild code all answer 400
  // invalid_challenge.
  app.post('/auth/desktop/exchange', async (c) => {
    if (wantsCookie(c) && !cookieModeAllowed(c)) {
      return c.json({ error: 'csrf_refused' }, 403)
    }
    const body = desktopExchangeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return sessionResponse(
      c,
      await deps.identity.exchangeDesktopCode(body.data.code, body.data.state),
      201
    )
  })

  // Unknown guilds get decoy options from the provider, so this answers the same for every id.
  app.post('/guilds/:id/sign-in/begin', async (c) => {
    return c.json(await deps.identity.beginSignIn(c.req.param('id')))
  })

  app.post('/guilds/:id/sign-in/finish', async (c) => {
    if (wantsCookie(c) && !cookieModeAllowed(c)) {
      return c.json({ error: 'csrf_refused' }, 403)
    }
    const guild = await ceremonyGuild(c)
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (!guild) {
      // Same answer as a known guild given a challenge it never issued.
      return c.json({ error: 'invalid_challenge' }, 400)
    }
    const session = await deps.identity.finishSignIn(
      guild,
      body.data.challengeId,
      body.data.response
    )
    return sessionResponse(c, session)
  })

  // Usernameless sign-in: the authenticator offers a discoverable credential, and the guild is
  // resolved from the credential id it asserts. No guild appears in the path.
  app.post('/sign-in/begin', async (c) => {
    return c.json(await deps.identity.beginDiscoverableSignIn())
  })

  app.post('/sign-in/finish', async (c) => {
    if (wantsCookie(c) && !cookieModeAllowed(c)) {
      return c.json({ error: 'csrf_refused' }, 403)
    }
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return sessionResponse(
      c,
      await deps.identity.finishDiscoverableSignIn(body.data.challengeId, body.data.response)
    )
  })

  /**
   * A browser asks for a cookie session (`x-session-mode: cookie`) and never receives the token
   * in the body; any other client gets the bearer token as before.
   */
  function sessionResponse(
    c: Context,
    session: IdentitySession,
    status: 200 | 201 = 200
  ): Response {
    if (!wantsCookie(c)) {
      return c.json(session, status)
    }
    const seconds = (session.expiresAt.getTime() - deps.clock.now().getTime()) / 1000
    c.header('Set-Cookie', sessionCookie(c, session.token, seconds))
    return c.json({ guildId: session.guildId, expiresAt: session.expiresAt }, status)
  }

  // Who the cookie (or bearer) session is; a reloaded page asks this before showing anything.
  app.get('/session', async (c) => {
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    return session
      ? c.json({ guildId: session.guildId })
      : c.json({ error: 'unauthenticated' }, 401)
  })

  // Sign-out: revokes the session server-side and clears the cookie. Idempotent.
  app.post('/session/logout', async (c) => {
    const token = sessionTokenOf(c)
    if (token) {
      await deps.identity.revokeSession(token)
    }
    c.header('Set-Cookie', clearedSessionCookie(c))
    return c.body(null, 204)
  })

  app.post('/session/reauth/begin', async (c) => {
    const token = sessionTokenOf(c)
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    return c.json(await deps.identity.beginReauth(token))
  })

  app.post('/session/reauth/finish', async (c) => {
    const token = sessionTokenOf(c)
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json(
      await deps.identity.finishReauth(token, body.data.challengeId, body.data.response)
    )
  })

  // A guild that is not the caller's is indistinguishable from one that does not exist.
  app.get('/guilds/:id', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const id = uuid.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const rows = await deps.db.withGuild(
      caller,
      (tx) => tx`select guild_id, name, goal from guilds where guild_id = ${id.data}`
    )
    const row = rows[0]
    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ id: row.guild_id, name: row.name, goal: row.goal })
  })

  // The Vault. Adding a secret is a sensitive action (fresh passkey re-authentication, spent by
  // the check); nothing here ever returns, logs or errors with a secret value.
  app.post('/guilds/:id/vault/secrets', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (c.req.param('id') !== check.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_SECRET_REQUEST_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    const raw = await readCapped(c.req.raw.body, MAX_SECRET_REQUEST_BYTES)
    if (!raw) {
      return c.json({ error: 'too_large' }, 413)
    }
    const body = addSecretBody.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(raw))
        } catch {
          return null
        }
      })()
    )
    if (!body.success) {
      return c.json({ error: 'invalid_secret' }, 400)
    }
    try {
      await deps.secrets.add(check.guildId, body.data.ref, body.data.value)
    } catch (error) {
      if (error instanceof SecretExistsError) {
        return c.json({ error: 'secret_exists' }, 409)
      }
      throw error
    }
    return c.json({ ref: body.data.ref }, 201)
  })

  app.get('/guilds/:id/vault/secrets', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = secretPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.secrets.list(caller, {
        limit: page.data.limit,
        ...(page.data.after ? { after: page.data.after } : {}),
      })
    )
  })

  app.post('/guilds/:id/vault/check', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const body = checkSecretsBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json({ results: await deps.secrets.check(caller, body.data.refs) })
  })

  // The Archive. Note writes are events (appended by the NoteStore in the write's transaction).
  // A guild that is not the caller's is indistinguishable from one that does not exist.
  async function archiveCaller(c: Context): Promise<{ guild: string } | Response> {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    return { guild: caller }
  }

  function noteFailure(c: Context, error: unknown): Response {
    if (error instanceof NoteError) {
      return error.code === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: error.code }, 422)
    }
    throw error
  }

  app.post('/guilds/:id/archive/notes', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const body = newNote.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    try {
      return c.json(await deps.notes.add(who.guild, body.data), 201)
    } catch (error) {
      return noteFailure(c, error)
    }
  })

  app.patch('/guilds/:id/archive/notes/:noteId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const noteId = uuid.safeParse(c.req.param('noteId'))
    const body = noteFields.partial().safeParse(await c.req.json().catch(() => null))
    if (!noteId.success || !body.success) {
      return c.json(
        { error: noteId.success ? 'invalid_request' : 'not_found' },
        noteId.success ? 400 : 404
      )
    }
    try {
      return c.json(await deps.notes.edit(who.guild, noteId.data, body.data))
    } catch (error) {
      return noteFailure(c, error)
    }
  })

  app.get('/guilds/:id/archive/notes/:noteId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const noteId = uuid.safeParse(c.req.param('noteId'))
    const detail = noteId.success
      ? await deps.notes.get(who.guild, noteId.data, undefined, { includePrivate: true })
      : null
    return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
  })

  // Lists notes, or full-text searches them with `?q=`.
  app.get('/guilds/:id/archive/notes', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = notePage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      q: c.req.query('q'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    // The Guild Master is not a Hall, so the private boundary does not apply to their reads.
    const paging = {
      limit: page.data.limit,
      includePrivate: true,
      ...(page.data.after ? { after: page.data.after } : {}),
    }
    return c.json(
      page.data.q === undefined
        ? await deps.notes.list(who.guild, paging)
        : await deps.notes.search(who.guild, page.data.q, paging)
    )
  })

  // A Hall's Missives for the Guild Master, newest first. The text is the sender's, untrusted:
  // the ledger shows it as text and never as markup.
  app.get('/guilds/:id/halls/:hallId/missives', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    const page = missivePage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { config } = await deps.config.current(who.guild)
    if (!hallId.success || !config.halls.some((h) => h.id === hallId.data)) {
      return c.json({ error: 'hall_not_found' }, 404)
    }
    return c.json(
      await deps.missives.list(who.guild, {
        hallId: hallId.data,
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  // Dossiers for the Guild Master: a Hall's (about its Quests or requested by it) newest first, one
  // by id, and a new one for any finished Quest. Code assembles them from stored records and
  // re-checks every hash; the Guild Master is not a Hall, so the private boundary does not apply.
  app.get('/guilds/:id/halls/:hallId/dossiers', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    const page = dossierPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { config } = await deps.config.current(who.guild)
    if (!hallId.success || !config.halls.some((h) => h.id === hallId.data)) {
      return c.json({ error: 'hall_not_found' }, 404)
    }
    return c.json(
      await deps.dossierStore.list(who.guild, {
        hallId: hallId.data,
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  // The Council of Elders' sessions for the Guild Master, newest first, each with its votes, the
  // summed cost of its voices and, once escalated, the Seal its Quest is waiting on. Read-only.
  app.get('/guilds/:id/council/sessions', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const page = councilPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const listed = await deps.councilStore.list(who.guild, {
      limit: page.data.limit,
      ...(page.data.after === undefined ? {} : { after: page.data.after }),
    })
    const titles = await questTitles(
      deps.quests,
      who.guild,
      listed.sessions.map((s) => s.questId)
    )
    const halted = await deps.councilStore.haltedSessions(
      who.guild,
      listed.sessions.map((s) => s.id)
    )
    const sessions = await Promise.all(
      listed.sessions.map(async (session) => {
        const votes = await deps.councilStore.votes(who.guild, session.id)
        const seal =
          session.status === 'escalated'
            ? await deps.sealStore.forQuest(who.guild, session.questId)
            : null
        const costs = votes.flatMap((v) => (v.costMicros === null ? [] : [v.costMicros]))
        return {
          ...session,
          questTitle: titles.get(session.questId) ?? null,
          halted: halted.has(session.id),
          sealId: seal?.id ?? null,
          costMicros: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
          votes: votes.map(({ sessionId: _s, ...vote }) => vote),
        }
      })
    )
    return c.json({ sessions, next: listed.next })
  })

  app.get('/guilds/:id/dossiers/:dossierId', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const dossier = await deps.dossierStore.get(who.guild, c.req.param('dossierId'))
    return dossier ? c.json(dossier) : c.json({ error: 'dossier_not_found' }, 404)
  })

  app.post('/guilds/:id/dossiers', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = createDossierInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const made = await deps.dossiers.request(who.guild, body.data.questId, {
      kind: 'guild_master',
    })
    if (!made.ok) {
      return made.error === 'unknown_quest'
        ? c.json({ error: 'quest_not_found' }, 404)
        : c.json({ error: made.error }, 422)
    }
    return c.json(made.dossier, 201)
  })

  // Bug Reports for the Guild Master: file one against any Hall (a Fix Quest is posted on that
  // Hall's Quest Board), list a Hall's newest first by status, read one by id. The Guild Master is
  // not a Hall, so the private boundary does not apply, and has no cap.
  app.get('/guilds/:id/halls/:hallId/bug-reports', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    const page = bugReportPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      status: c.req.query('status'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { config } = await deps.config.current(who.guild)
    if (!hallId.success || !config.halls.some((h) => h.id === hallId.data)) {
      return c.json({ error: 'hall_not_found' }, 404)
    }
    return c.json(
      await deps.bugReportStore.list(who.guild, {
        hallId: hallId.data,
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
        ...(page.data.status === undefined ? {} : { status: page.data.status }),
      })
    )
  })

  app.get('/guilds/:id/bug-reports/:reportId', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const report = await deps.bugReportStore.get(who.guild, c.req.param('reportId'))
    return report ? c.json(report) : c.json({ error: 'bug_report_not_found' }, 404)
  })

  app.post('/guilds/:id/bug-reports', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = fileBugReportInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const filed = await deps.bugReports.file(who.guild, body.data, { kind: 'guild_master' })
    if (!filed.ok) {
      return filed.error === 'unknown_hall'
        ? c.json({ error: 'hall_not_found' }, 404)
        : c.json({ error: filed.error }, 422)
    }
    return c.json({ ...filed.report, fixQuest: filed.fixQuest }, 201)
  })

  // A Hall's Inquiries for the Guild Master, asked and received, newest first. The question and
  // answer are Members' words, untrusted: the ledger shows them as text and never as markup.
  app.get('/guilds/:id/halls/:hallId/inquiries', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    const page = inquiryPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { config } = await deps.config.current(who.guild)
    if (!hallId.success || !config.halls.some((h) => h.id === hallId.data)) {
      return c.json({ error: 'hall_not_found' }, 404)
    }
    return c.json(
      await deps.inquiries.list(who.guild, {
        hallId: hallId.data,
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  // One Inquiry for the Guild Master; an unknown id and another guild's id look the same.
  app.get('/guilds/:id/inquiries/:inquiryId', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const inquiry = await deps.inquiries.get(who.guild, c.req.param('inquiryId'))
    return inquiry ? c.json(inquiry) : c.json({ error: 'inquiry_not_found' }, 404)
  })

  // Quests. Posting and every transition is an event appended by the QuestQueue. Like the
  // Archive, a guild that is not the caller's is indistinguishable from one that does not exist.
  app.post('/guilds/:id/quests', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = postQuestInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await postQuest(
      { config: deps.config, queue: deps.quests, tripwires: deps.tripwires },
      who.guild,
      body.data
    )
    if (!result.ok) {
      return c.json({ error: result.error }, 422)
    }
    return c.json(result.quest, result.created ? 201 : 200)
  })

  // A team Campaign: the Guild Master gives the Hall's Captain a goal. It is one ordinary Quest.
  app.post('/guilds/:id/campaigns/team', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = startTeamCampaignInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await startTeamCampaign(
      { config: deps.config, queue: deps.quests, tripwires: deps.tripwires },
      who.guild,
      body.data
    )
    if (!result.ok) {
      return c.json({ error: result.error }, 422)
    }
    return c.json(
      { campaignId: body.data.campaignId, questId: result.quest.id },
      result.created ? 201 : 200
    )
  })

  async function questList(c: Context, dead: boolean): Promise<Response> {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = questPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      state: c.req.query('state'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const paging = {
      limit: page.data.limit,
      ...(page.data.after ? { after: page.data.after } : {}),
    }
    const listed = dead
      ? await deps.quests.deadLetters(who.guild, paging)
      : await deps.quests.list(who.guild, {
          ...paging,
          ...(page.data.state ? { state: page.data.state } : {}),
        })
    // The Sub-Quest links of this page, so the Quest Board can nest children under their parent.
    const links = await deps.quests.linksFor(
      who.guild,
      listed.quests.map((q) => q.id)
    )
    // Why a waiting Quest waits: the block logged for its current attempt (`<id>:<attempts>`), so
    // a decision of an earlier attempt never shows. One bounded, guild-scoped lookup per page.
    const waiting = listed.quests.filter((q) => q.state === 'queued')
    const logged = await deps.routingLog.forKeys(
      who.guild,
      waiting.map((q) => `${q.id}:${q.attempts}`)
    )
    const blocked = new Map<string, BlockReason>()
    for (const entry of logged) {
      if (entry.outcome === 'blocked' && entry.reason !== null) {
        blocked.set(entry.decisionKey, entry.reason)
      }
    }
    // A locked Hall is skipped at claim and never logs a decision, so it is reported from the config.
    const locked = new Set(
      waiting.length > 0 ? lockedHallIds((await deps.config.current(who.guild)).config) : []
    )
    const quests = listed.quests.map((q) => ({
      ...q,
      blockReason:
        q.state !== 'queued'
          ? null
          : locked.has(q.hallId)
            ? ('hall_locked' as const)
            : (blocked.get(`${q.id}:${q.attempts}`) ?? null),
    }))
    return c.json({ ...listed, quests, links })
  }

  // Model gateway: a run calls with its per-run token (not a session), and the real provider key
  // never leaves the gateway. Failures are coded; none carries provider text.
  app.post('/gateway/complete', async (c) => {
    const token = bearerToken(c.req.header('authorization'))
    if (!token) {
      return c.json({ error: 'invalid_token' }, 401)
    }
    const call = gatewayCall.safeParse(await c.req.json().catch(() => null))
    if (!call.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const spent = await chargeTokenGuild(c, 'gateway-call', await deps.gateway.verifiedGuild(token))
    if (spent) {
      return spent
    }
    try {
      return c.json(await deps.gateway.complete(token, call.data))
    } catch (e) {
      if (!(e instanceof GatewayError)) {
        throw e
      }
      return c.json({ error: e.code }, gatewayStatus(e.code))
    }
  })

  // The cost table of the ledger view: spend per run, Quest, Hall or day.
  app.get('/guilds/:id/gateway/usage', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const query = usageQuery.safeParse({
      by: c.req.query('by') ?? 'day',
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (
      !query.success ||
      (query.data.by === 'day' && query.data.after !== undefined && !isUsageDate(query.data.after))
    ) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.gateway.usage(who.guild, query.data.by, {
        limit: query.data.limit,
        ...(query.data.after === undefined ? {} : { after: query.data.after }),
      })
    )
  })

  app.get('/guilds/:id/quests', (c) => questList(c, false))
  app.get('/guilds/:id/quests/dead-letters', (c) => questList(c, true))

  // Tripwires and Hall pauses. Reading shows the thresholds and the active pauses (the ledger
  // view's problem list). Pausing is immediate and needs only a session; resuming widens what the
  // Hall may do, so it needs a fresh re-authentication, like confirming a widening config change.
  app.get('/guilds/:id/tripwires', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = pausePage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { config } = await deps.config.current(who.guild)
    const paused = await deps.tripwires.list(who.guild, {
      limit: page.data.limit,
      ...(page.data.after ? { after: Number(page.data.after) } : {}),
    })
    return c.json({ thresholds: guildTripwires(config), ...paused })
  })

  app.post('/guilds/:id/halls/:hallId/pause', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    const { config } = await deps.config.current(who.guild)
    if (!hallId.success || !config.halls.some((h) => h.id === hallId.data)) {
      return c.json({ error: 'hall_not_found' }, 404)
    }
    const { pause, created } = await deps.tripwires.pause(who.guild, {
      hallId: hallId.data,
      tripwire: 'manual',
      observed: 0,
      threshold: 0,
    })
    await deps.gateway.revokeHallRuns(who.guild, hallId.data)
    return c.json(pause, created ? 201 : 200)
  })

  app.post('/guilds/:id/halls/:hallId/resume', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    const hallId = hallParam.safeParse(c.req.param('hallId'))
    if (c.req.param('id') !== check.guildId || !hallId.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const resumed = await deps.tripwires.resume(check.guildId, hallId.data)
    if (resumed) {
      // The loop count that paused the Hall must not re-pause it at the next pass.
      await deps.quests.forgiveRepeats(check.guildId, hallId.data)
    }
    return resumed
      ? c.json({ hallId: hallId.data, paused: false })
      : c.json({ error: 'not_paused' }, 404)
  })

  // Bar the Gates, the kill switch. Barring is immediate (a session plus the Guild Master role):
  // it only narrows what runs. Lifting widens it again, so it needs a fresh passkey
  // re-authentication. `/guilds/:id/gates/*` acts on one guild; `/gates/*` on every guild, with
  // the event chained in the acting Guild Master's own guild.
  app.get('/guilds/:id/gates', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    // `operator` tells the ledger whether this caller may bar or lift every guild, so it shows
    // those controls to platform operators only; the global routes enforce it regardless.
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    return c.json({
      ...(await deps.gates.status(who.guild)),
      operator: session !== null && isGuildMaster(session) && isOperator(session.memberId),
    })
  })

  // "Summon your first member": the check stays incomplete until its test Quest has run on the
  // sandboxed worker with the chosen provider and passed. Starting it is the Guild Master's; it is
  // idempotent, so a retry never starts a second worker.
  app.get('/guilds/:id/summon', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    return c.json(await deps.summon.status(who.guild))
  })

  app.post('/guilds/:id/summon', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = summonBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const started = await deps.summon.start(who.guild, body.data.profileId)
    if (started.ok) {
      return c.json(started.status, 202)
    }
    const status =
      started.error === 'gates_barred' ? 409 : started.error === 'sandbox_unavailable' ? 502 : 422
    return c.json({ error: started.error }, status)
  })

  // Cost per accepted post: metered spend of the Quests whose Seal was posted, per Campaign.
  app.get('/guilds/:id/cost-per-post', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const query = costPerPostQuery.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!query.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await costPerPost({ postCosts: deps.postCosts }, who.guild, {
        limit: query.data.limit,
        ...(query.data.after === undefined ? {} : { after: query.data.after }),
      })
    )
  })

  // One dispatcher pass: settles Seals, then claims, routes and starts at most one Quest.
  app.post('/guilds/:id/dispatch', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const done = await deps.dispatcher.dispatch(who.guild)
    const status =
      done.status === 'started'
        ? 202
        : done.status === 'barred'
          ? 409
          : done.status === 'failed'
            ? done.error === 'gates_barred'
              ? 409
              : done.error === 'sandbox_unavailable'
                ? 502
                : 422
            : 200
    return c.json(done, status)
  })

  /** Whether the member is a platform operator; ids compare case-insensitively. */
  function isOperator(memberId: string): boolean {
    const id = memberId.toLowerCase()
    return deps.platformOperators.some((o) => o.toLowerCase() === id)
  }

  async function barRoute(c: Context, scope: 'guild' | 'global'): Promise<Response> {
    const who = scope === 'guild' ? await guildMasterSessionFor(c) : await operatorSession(c)
    if ('res' in who) {
      return who.res
    }
    const outcome = await deps.gates.bar({ guildId: who.guild, memberId: who.member }, scope)
    return c.json({ ...outcome, scope }, outcome.created ? 201 : 200)
  }

  async function liftRoute(c: Context, scope: 'guild' | 'global'): Promise<Response> {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (!isGuildMaster(check.principal)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    if (scope === 'global' && !isOperator(check.principal.memberId)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    if (scope === 'guild' && c.req.param('id') !== check.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    const lifted = await deps.gates.lift(
      { guildId: check.guildId, memberId: check.principal.memberId },
      scope
    )
    return lifted ? c.json({ scope, barred: false }) : c.json({ error: 'not_barred' }, 404)
  }

  /** A session whose principal is a Guild Master and a platform operator (env `PLATFORM_OPERATORS`); for the global bar. */
  async function operatorSession(
    c: Context
  ): Promise<{ guild: string; member: string } | { res: Response }> {
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!session) {
      return { res: c.json({ error: 'unauthenticated' }, 401) }
    }
    return isGuildMaster(session) && isOperator(session.memberId)
      ? { guild: session.guildId, member: session.memberId }
      : { res: c.json({ error: 'forbidden' }, 403) }
  }

  app.post('/guilds/:id/gates/bar', (c) => barRoute(c, 'guild'))
  app.post('/guilds/:id/gates/lift', (c) => liftRoute(c, 'guild'))
  app.post('/gates/bar', (c) => barRoute(c, 'global'))
  app.post('/gates/lift', (c) => liftRoute(c, 'global'))

  // Web push for the Guild Master's installed PWA. A device subscribes with the browser's
  // PushSubscription; the push for a Seal request carries ids only (see `seal-push.ts`).
  app.get('/guilds/:id/push/key', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    return deps.vapidPublicKey
      ? c.json({ publicKey: deps.vapidPublicKey })
      : c.json({ error: 'push_not_configured' }, 404)
  })

  app.post('/guilds/:id/push/subscriptions', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = pushSubscribeBody.safeParse(await c.req.json().catch(() => null))
    if (
      !body.success ||
      !isPushEndpoint(body.data.endpoint, deps.pushAllowedHosts ?? PUSH_SERVICE_HOSTS)
    ) {
      return c.json({ error: 'invalid_subscription' }, 400)
    }
    // Events up to now are never pushed to this device; nothing here waits on a push service.
    const sinceSeq = await deps.db.withGuild(who.guild, headSeq)
    const added = await deps.pushStore.add(
      who.guild,
      who.member,
      { endpoint: body.data.endpoint, p256dh: body.data.keys.p256dh, auth: body.data.keys.auth },
      sinceSeq
    )
    return added === 'conflict'
      ? c.json({ error: 'endpoint_taken' }, 409)
      : c.json({ endpoint: body.data.endpoint }, 201)
  })

  app.delete('/guilds/:id/push/subscriptions', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = pushUnsubscribeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_subscription' }, 400)
    }
    const removed = await deps.pushStore.remove(who.guild, who.member, body.data.endpoint)
    if (removed === 'conflict') {
      return c.json({ error: 'endpoint_taken' }, 409)
    }
    return removed === 'removed' ? c.body(null, 204) : c.json({ error: 'not_found' }, 404)
  })

  // The Guild Master's character look: saved server-side so every device shows the same character.
  // The body is checked against the fixed catalogue; a look is cosmetic and governs nothing.
  app.get('/guilds/:id/guild-master/look', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    return c.json({ look: await deps.guildMasterLooks.get(who.guild) })
  })

  app.put('/guilds/:id/guild-master/look', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = z.object({ look: characterLook }).safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_look' }, 400)
    }
    await deps.guildMasterLooks.set(who.guild, body.data.look)
    return c.json({ look: body.data.look })
  })

  // Away mode (ADR-0011): the Guild Master steps away, optionally until a time, and returns with one
  // tap. It needs a Guild Master session but no Seal: away mode narrows nothing, and the Council
  // can only act inside caps already sealed. A passed return time reads as present.
  const awayBody = z.object({ until: z.string().datetime().nullable().optional() }).strict()
  function presenceView(state: PresenceState) {
    return isAway(state, deps.clock.now()) ? state : { away: false, since: null, until: null }
  }

  app.get('/guilds/:id/guild-master/presence', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    return c.json(presenceView(await deps.presence.get(who.guild)))
  })

  // "While you were away": a paginated read of the latest away window (Council approvals,
  // escalations, Seals still waiting, Quests done, Treasury spend), oldest first. Read-only.
  app.get('/guilds/:id/guild-master/away-digest', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const page = digestPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const digest = await deps.db.withGuild(who.guild, (tx) =>
      awayDigest(tx, page.data, deps.clock.now(), async (sealId) => {
        const seal = await deps.sealStore.get(who.guild, sealId)
        return seal?.status === 'requested'
      })
    )
    const titles = await questTitles(
      deps.quests,
      who.guild,
      digest.entries.map((e) => e.questId)
    )
    return c.json({
      ...digest,
      entries: digest.entries.map((e) => ({
        ...e,
        questTitle: e.questId === null ? null : (titles.get(e.questId) ?? null),
      })),
    })
  })

  app.post('/guilds/:id/guild-master/away', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = awayBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_away' }, 400)
    }
    const until = body.data.until ? new Date(body.data.until).toISOString() : null
    const nowMs = deps.clock.now().getTime()
    // A return time must be in the future and at most 30 days ahead; no return time stays allowed.
    if (
      until !== null &&
      (new Date(until).getTime() <= nowMs || new Date(until).getTime() > nowMs + 30 * 86_400_000)
    ) {
      return c.json({ error: 'invalid_away' }, 400)
    }
    return c.json(presenceView(await deps.presence.goAway(who.guild, until)))
  })

  app.post('/guilds/:id/guild-master/return', async (c) => {
    const who = await guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    await deps.presence.returnHome(who.guild)
    return c.json(presenceView(await deps.presence.get(who.guild)))
  })

  // Trades a signed-in session for a 30 second, single-use ticket that opens one event stream.
  app.post('/guilds/:id/events/ticket', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    return c.json(await deps.streamTickets.issue(who.guild))
  })

  // Guild config. Reads follow `callerGuild`. Writes need a real session: the dev header never
  // writes config, and agents have no session, so no agent-facing route can change it. A widening
  // change is stored pending and only `confirm`, behind re-authentication, puts it in force.
  /** The calling session's guild when it is `:id`, else a ready response. */
  async function sessionGuildFor(
    c: Context
  ): Promise<{ guild: string; member: string; role: string } | { res: Response }> {
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!session) {
      return { res: c.json({ error: 'unauthenticated' }, 401) }
    }
    if (c.req.param('id') !== session.guildId) {
      return { res: c.json({ error: 'not_found' }, 404) }
    }
    return { guild: session.guildId, member: session.memberId, role: session.role }
  }

  /** {@link sessionGuildFor}, then only the Guild Master passes; any other principal gets a 403. */
  async function guildMasterSessionFor(
    c: Context
  ): Promise<{ guild: string; member: string } | { res: Response }> {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who
    }
    return isGuildMaster(who)
      ? { guild: who.guild, member: who.member }
      : { res: c.json({ error: 'forbidden' }, 403) }
  }

  /** Whether `config` names a `subscription` provider the host has not enabled (save and restore share this). */
  function namesDisabledSubscription(config: GuildConfig): boolean {
    return !deps.subscriptionEnabled && config.providers.some((p) => p.auth === 'subscription')
  }

  function configFailure(c: Context, error: unknown): Response {
    if (error instanceof ConfigError) {
      return error.code === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: error.code }, 409)
    }
    throw error
  }

  app.get('/guilds/:id/config', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      return c.json(await deps.config.current(caller))
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.get('/guilds/:id/config/versions', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = versionPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.config.history(caller, {
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  // The ledger view's roster: the Steward plus Halls (with Captain and Members), paginated by Hall id.
  app.get('/guilds/:id/roster', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = rosterPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    try {
      const { config } = await deps.config.current(caller)
      const halls = config.halls
        .filter((h) => page.data.after === undefined || h.id > page.data.after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const items = halls.slice(0, page.data.limit)
      const last = items.at(-1)
      return c.json({
        steward: config.steward,
        halls: items,
        next: halls.length > page.data.limit && last ? last.id : null,
      })
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.put('/guilds/:id/config', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = putConfigBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      const unknownKeys = body.error.issues.flatMap((i) =>
        i.code === 'unrecognized_keys' ? i.keys.map((k) => [...i.path.slice(1), k].join('.')) : []
      )
      if (unknownKeys.length > 0) {
        const listed = unknownKeys.slice(0, MAX_UNKNOWN_KEYS_LISTED).map(shortenUnknownKey)
        const truncated =
          unknownKeys.length > MAX_UNKNOWN_KEYS_LISTED ||
          unknownKeys.some((k) => k.length > MAX_UNKNOWN_KEY_LENGTH)
        return c.json(
          {
            error: 'unknown_config_key',
            unknownKeys: listed,
            ...(truncated ? { truncated: true } : {}),
          },
          422
        )
      }
      // Paths and messages only, so the builder can mark the offending node; never the submitted values.
      return c.json(
        {
          error: 'invalid_config',
          // Paths under `config` are relative to the config document, not the request body that wraps it.
          issues: body.error.issues.map((i) => ({
            path: i.path[0] === 'config' ? i.path.slice(1) : i.path,
            message: i.message,
          })),
        },
        400
      )
    }
    if (namesDisabledSubscription(body.data.config)) {
      return c.json({ error: 'subscription_disabled' }, 409)
    }
    try {
      const result = await deps.config.propose(who.guild, body.data.config, {
        baseVersion: body.data.baseVersion,
      })
      return c.json(result, result.status === 'pending' ? 202 : 200)
    } catch (error) {
      return configFailure(c, error)
    }
  })

  // Where private text would go: whether this Guildhall serves subscription providers at all
  // (hosted when the host has not enabled them) and the vendor every provider call reaches.
  app.get('/guilds/:id/providers/status', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    // Report a vendor only when every bound adapter agrees; never guess between several.
    const vendors = [...new Set(deps.providerVendors ?? [])]
    const [vendor] = vendors
    if (vendors.length !== 1 || vendor === undefined) {
      return c.json({ error: 'provider_vendor_unclear' }, 500)
    }
    return c.json({ hosted: !deps.subscriptionEnabled, vendor })
  })

  app.post('/guilds/:id/config/versions/:version/restore', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const version = configVersion.safeParse(c.req.param('version'))
    if (!version.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      const stored = await deps.config.get(who.guild, version.data)
      if (stored && namesDisabledSubscription(stored.config)) {
        return c.json({ error: 'subscription_disabled' }, 409)
      }
      const result = await deps.config.restore(who.guild, version.data)
      return c.json(result, result.status === 'pending' ? 202 : 200)
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.post('/guilds/:id/config/versions/:version/confirm', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    const version = configVersion.safeParse(c.req.param('version'))
    if (c.req.param('id') !== check.guildId || !version.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      await deps.config.confirm(check.guildId, version.data)
      return c.json({ version: version.data, status: 'applied' })
    } catch (error) {
      return configFailure(c, error)
    }
  })

  mountRiteRoutes(app, {
    rites: deps.rites,
    identity: deps.identity,
    sessionGuildFor,
    guildMasterSessionFor,
  })

  mountCharterRoutes(app, {
    rites: deps.rites,
    config: deps.config,
    clock: deps.clock,
    imports: deps.charterImports,
    namesDisabledSubscription,
    guildName: async (id) => {
      const rows = await deps.db.withGuild(
        id,
        (tx) => tx`select name from guilds where guild_id = ${id}`
      )
      const name = rows[0]?.name
      return typeof name === 'string' ? name : null
    },
    recordExported: async (id, fact) => {
      await deps.db.withGuild(id, (tx) => appendEvent(tx, deps.keys, CHARTER_EVENT.exported, fact))
    },
    guildMasterSessionFor,
  })

  mountArchiveExportRoutes(app, {
    notes: deps.notes,
    config: deps.config,
    clock: deps.clock,
    guildName: async (id) => {
      const rows = await deps.db.withGuild(
        id,
        (tx) => tx`select name from guilds where guild_id = ${id}`
      )
      const name = rows[0]?.name
      return typeof name === 'string' ? name : null
    },
    checkSensitive: (c) => checkSensitive(deps.identity, sessionHeaders(c)),
    recordExported: async (id, fact) => {
      await deps.db.withGuild(id, (tx) => appendEvent(tx, deps.keys, ARCHIVE_EVENT.exported, fact))
    },
    guildMasterSessionFor,
  })

  // Audit verification: replays the guild's chain with the KeyProvider's key. A guild that is not
  // the caller's is indistinguishable from one that does not exist.
  const witness = { anchor: deps.anchor, identity: deps.identity, clock: deps.clock }
  app.get('/guilds/:id/audit/verify', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const query = verifyQuery.safeParse(c.req.query())
    if (!query.success) {
      return c.json({ error: 'invalid_query' }, 400)
    }
    try {
      return c.json(
        await deps.db.withGuild(caller, (tx) =>
          verifyChain(tx, deps.keys, witness, {
            ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
            ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
            full: query.data.full === 'true',
          })
        )
      )
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  // The Guild Master's daily act, as a passkey ceremony: `begin` verifies the chain and issues a
  // challenge carrying the hash of the position (seq + MAC) to sign; `finish` checks the
  // assertion, re-verifies the chain through exactly that position, then records the checkpoint
  // with the assertion and anchors it outside Postgres. The assertion is itself a fresh proof.
  app.post('/guilds/:id/audit/checkpoints/begin', async (c) => {
    const body = checkpointBeginBody.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!token || !session) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== session.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    const { verdict, position } = await deps.db.withGuild(session.guildId, (tx) =>
      verifyFrom(
        tx,
        deps.keys,
        witness,
        body.data.limit === undefined ? {} : { limit: body.data.limit }
      )
    )
    if (!verdict.intact || position.seq < 1) {
      return c.json(verdict, 409)
    }
    const ceremony = await deps.identity.beginCheckpointSignature(
      token,
      checkpointHash(session.guildId, position.seq, position.mac)
    )
    return c.json({
      ...ceremony,
      seq: position.seq,
      mac: position.mac,
      complete: !('partial' in verdict),
    })
  })

  app.post('/guilds/:id/audit/checkpoints/finish', async (c) => {
    const body = checkpointFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_body' }, 400)
    }
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!token || !session) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== session.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    const signed = await deps.identity.finishCheckpointSignature(
      token,
      body.data.challengeId,
      body.data.response
    )
    const { seq, mac, limit } = body.data
    if (signed.checkpointHash !== checkpointHash(session.guildId, seq, mac)) {
      return c.json({ error: 'checkpoint_mismatch' }, 409)
    }
    const outcome = await deps.db.withGuild(session.guildId, (tx) =>
      signCheckpoint(tx, deps.keys, witness, {
        ...(limit === undefined ? {} : { limit }),
        expect: { seq, mac },
        assertion: signed.assertion,
      })
    )
    if (!outcome.ok) {
      return c.json(outcome.verdict, 409)
    }
    return c.json(
      {
        seq: outcome.seq,
        mac: outcome.mac,
        signature: outcome.signature,
        complete: outcome.complete,
      },
      201
    )
  })

  // Artifacts: the bytes live in the ObjectStore under the caller's guild namespace; the row
  // records hash, size and class. Idempotent: the same bytes again change nothing.
  app.on(['PUT', 'POST'], '/artifacts', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const cls = artifactClass.safeParse(c.req.query('class'))
    if (!cls.success) {
      return c.json({ error: 'invalid_class' }, 400)
    }
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > maxBytes) {
      return c.json({ error: 'too_large' }, 413)
    }
    const bytes = await readCapped(c.req.raw.body, maxBytes)
    if (!bytes) {
      return c.json({ error: 'too_large' }, 413)
    }
    const hash = await withStoreTimeout(deps.objectStore.put(caller, bytes))
    const stored = await deps.db.withGuild(caller, async (tx) => {
      const inserted = await tx`
        insert into artifacts (guild_id, hash, size, class)
        values (${caller}, ${hash}, ${bytes.byteLength}, ${cls.data})
        on conflict (guild_id, hash) do nothing
        returning hash`
      if (inserted.length > 0) {
        await appendEvent(tx, deps.keys, 'artifact.stored', {
          hash,
          class: cls.data,
          size: bytes.byteLength,
        })
      }
      const [row] =
        await tx`select class from artifacts where guild_id = ${caller} and hash = ${hash}`
      return String(row?.class)
    })
    return c.json({ hash, size: bytes.byteLength, class: stored }, 201)
  })

  // An artifact that is not the caller's is indistinguishable from one that does not exist.
  app.get('/artifacts/:hash', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const hash = artifactHash.safeParse(c.req.param('hash'))
    if (!hash.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const rows = await deps.db.withGuild(
      caller,
      (tx) => tx`select class from artifacts where guild_id = ${caller} and hash = ${hash.data}`
    )
    const bytes = rows[0] ? await withStoreTimeout(deps.objectStore.get(caller, hash.data)) : null
    if (!rows[0] || !bytes) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.body(bytes.slice(), 200, {
      'content-type': 'application/octet-stream',
      'x-artifact-class': String(rows[0].class),
    })
  })

  /**
   * Read-only replay page of the event log: `?after=<seq>&limit=<n>&until=<seq or ISO time>`.
   * Session-guarded; the client folds the events into the state implied at the `until` point.
   */
  app.get('/guilds/:id/events/history', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const query = historyQuery.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      until: c.req.query('until'),
    })
    if (!query.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { after, limit, until } = query.data
    const bound: EventBound =
      until === undefined
        ? null
        : /^\d+$/.test(until)
          ? { seq: Number(until) }
          : { time: new Date(until).toISOString() }
    const page = await deps.db.withGuild(who.guild, (tx) => eventsHistory(tx, after, limit, bound))
    return c.json(page)
  })

  /**
   * Live event stream. The client sends `?last_seq=N` (the last seq it has applied); the server
   * answers `{type:'snapshot', head}` (the log's head at connect) and then every event with
   * seq > N in order, then new ones as they commit. State lives in Postgres, not in this process:
   * each socket just remembers its own cursor.
   */
  app.get(
    '/guilds/:id/events',
    async (c, next) => {
      const headerCaller = await callerGuild(c)
      const presented = headerCaller ? null : presentedTicket(c)
      const caller = headerCaller ?? presented?.guild ?? null
      if (!caller) {
        return c.json({ error: 'unauthenticated' }, 401)
      }
      if (c.req.param('id') !== caller) {
        return c.json({ error: 'not_found' }, 404)
      }
      // Reserve the slot before upgrading so simultaneous upgrades cannot exceed the cap, and
      // before spending the ticket so a refused (429) attempt does not burn it.
      const slot = hub.reserve(caller)
      if (!slot) {
        return c.json({ error: 'too_many_streams' }, 429)
      }
      if (presented && !(await deps.streamTickets.consume(presented.guild, presented.ticket))) {
        slot()
        return c.json({ error: 'unauthenticated' }, 401)
      }
      streamSlots.set(c.req.raw, slot)
      try {
        await next()
      } catch (error) {
        slot()
        throw error
      }
      if (c.res.status >= 400) {
        slot()
      }
    },
    upgradeWebSocket((c) => {
      const guild = c.req.param('id') ?? ''
      const parsed = z.coerce
        .number()
        .int()
        .min(0)
        .safeParse(c.req.query('last_seq') ?? '0')
      const cursor = parsed.success ? parsed.data : 0
      let subscription: ReturnType<typeof hub.subscribe> | undefined
      const slot = streamSlots.get(c.req.raw)
      return {
        onOpen: (_evt, ws) => {
          subscription = hub.subscribe(guild, cursor, {
            send: (data) => ws.send(data),
            // Unknown buffer size fails closed: treated as over any threshold, so the hub closes it.
            bufferedAmount: () => readBufferedAmount(ws.raw) ?? Number.POSITIVE_INFINITY,
            close: (code, reason) => ws.close(code, reason),
          })
          slot?.()
          const sub = subscription
          deps.db
            .withGuildStream(guild, (tx) => headSeq(tx))
            .then((head) => {
              ws.send(JSON.stringify({ type: 'snapshot', head }))
              sub.start()
            })
            .catch(() => ws.close(1011, 'event stream failed'))
        },
        onClose: () => subscription?.unsubscribe(),
      }
    }),
    (c) => c.json({ error: 'upgrade_required' }, 426)
  )
  // Proposals and Verdicts. Reads follow `callerGuild`; a write needs a real session (the dev header
  // never writes). The Verdict is computed here by deterministic checks and bound to the content hash.
  app.post('/guilds/:id/proposals', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = proposalBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json(await deps.proposals.propose(who.guild, body.data), 201)
  })

  app.get('/guilds/:id/proposals', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = proposalPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.proposals.list(who.guild, {
        limit: page.data.limit,
        ...(page.data.after ? { after: page.data.after } : {}),
      })
    )
  })

  app.get('/guilds/:id/proposals/:proposalId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const id = uuid.safeParse(c.req.param('proposalId'))
    const proposal = id.success ? await deps.proposals.get(who.guild, id.data) : null
    return proposal ? c.json(proposal) : c.json({ error: 'not_found' }, 404)
  })

  app.get('/guilds/:id/verdicts/:hash', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const hash = actionHash.safeParse(c.req.param('hash'))
    const verdict = hash.success ? await deps.proposals.verdictFor(who.guild, hash.data) : null
    return verdict ? c.json(verdict) : c.json({ error: 'not_found' }, 404)
  })

  // The Seal inbox. Reads follow `callerGuild`; approving or denying is a sensitive action (fresh
  // passkey re-authentication, spent by the check) made by the Guild Master's session; marking a
  // Seal posted needs the session. Only the session's own guild is ever acted on.
  function sealRefusal(c: Context, reason: SealRefusal): Response {
    switch (reason) {
      case 'not_found':
        return c.json({ error: 'not_found' }, 404)
      case 'not_authorised':
        return c.json({ error: reason }, 403)
      default:
        return c.json({ error: reason }, 409)
    }
  }

  app.get('/guilds/:id/seals', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = sealPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      status: c.req.query('status'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const found = await deps.seals.list(who.guild, {
      limit: page.data.limit,
      ...(page.data.after ? { after: page.data.after } : {}),
      ...(page.data.status ? { status: page.data.status } : {}),
    })
    const titles = await questTitles(
      deps.quests,
      who.guild,
      found.seals.map((s) => s.questId)
    )
    return c.json({
      ...found,
      seals: found.seals.map((s) => ({ ...s, questTitle: titles.get(s.questId) ?? null })),
    })
  })

  app.get('/guilds/:id/seals/:sealId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const id = uuid.safeParse(c.req.param('sealId'))
    const seal = id.success ? await deps.seals.get(who.guild, id.data) : null
    if (!seal) {
      return c.json({ error: 'not_found' }, 404)
    }
    const titles = await questTitles(deps.quests, who.guild, [seal.questId])
    return c.json({ ...seal, questTitle: titles.get(seal.questId) ?? null })
  })

  for (const [verb, verdict] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    app.post(`/guilds/:id/seals/:sealId/${verb}`, async (c) => {
      const check = await checkSensitive(deps.identity, sessionHeaders(c))
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      const id = uuid.safeParse(c.req.param('sealId'))
      if (c.req.param('id') !== check.guildId || !id.success) {
        return c.json({ error: 'not_found' }, 404)
      }
      const body = sealDecisionBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      const result = await deps.seals.decide(
        check.guildId,
        id.data,
        {
          verdict,
          expectedHash: body.data.actionHash,
          ...(body.data.note ? { note: body.data.note } : {}),
        },
        // The decider is the session's real principal; the engine refuses it as its own requester.
        { role: check.principal.role, id: check.principal.memberId }
      )
      return result.ok ? c.json(result.seal) : sealRefusal(c, result.reason)
    })
  }

  // Marking posted names the exact text that was published; the server hashes it and compares it
  // with the sealed hash. Resolving a stale reservation this way needs a fresh re-authentication.
  app.post('/guilds/:id/seals/:sealId/posted', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = uuid.safeParse(c.req.param('sealId'))
    if (!id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const body = sealPostedBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    // A proof, if sent, is checked and spent here; whether the reservation is stale is decided by
    // the store under its row lock, so a reservation lapsing mid-request cannot skip re-auth.
    let reauthenticated = false
    if (c.req.header(REAUTH_HEADER)) {
      const check = await checkSensitive(deps.identity, sessionHeaders(c))
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      if (check.guildId !== who.guild) {
        return c.json({ error: 'not_found' }, 404)
      }
      reauthenticated = true
    }
    const result = await deps.seals.markPosted(who.guild, id.data, body.data.text, {
      reauthenticated,
    })
    if (!result.ok && result.reason === 'not_authorised') {
      return c.json({ error: 'reauth_required' }, 403)
    }
    return result.ok ? c.json(result.seal) : sealRefusal(c, result.reason)
  })

  // The Guild Master frees a stale reservation after confirming nothing was published.
  app.post('/guilds/:id/seals/:sealId/release-stale', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    const id = uuid.safeParse(c.req.param('sealId'))
    if (c.req.param('id') !== check.guildId || !id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const result = await deps.seals.releaseStale(check.guildId, id.data)
    return result.ok ? c.json(result.seal) : sealRefusal(c, result.reason)
  })

  // The paper Treasury (mode: paper; no payment provider is ever called). Reads follow
  // `callerGuild`. Every write needs a real session (never the dev header; agents have none).
  // Approving a spend that waits for the Guild Master, and releasing the reserve, also need a fresh
  // re-authentication. The rules (limit, daily cap, funds) are code in the Treasury, never a model.
  const REFUSAL_STATUS: Record<TreasuryRefusal, 404 | 409 | 422> = {
    not_found: 404,
    wrong_state: 409,
    insufficient_funds: 409,
    invalid_amount: 422,
    evidence_required: 422,
    exceeds_reserved: 422,
    idempotency_conflict: 409,
  }

  /** A session whose principal is the Guild Master and whose guild is `:id`, else a ready response. */
  async function treasuryWriter(
    c: Context
  ): Promise<{ guild: string; memberId: string } | { res: Response }> {
    const token = sessionTokenOf(c)
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!session) {
      return { res: c.json({ error: 'unauthenticated' }, 401) }
    }
    if (c.req.param('id') !== session.guildId) {
      return { res: c.json({ error: 'not_found' }, 404) }
    }
    if (!isGuildMaster(session)) {
      return { res: c.json({ error: 'forbidden' }, 403) }
    }
    return { guild: session.guildId, memberId: session.memberId }
  }

  async function treasuryRoute(c: Context, run: () => Promise<Response>): Promise<Response> {
    try {
      return await run()
    } catch (error) {
      return configFailure(c, error)
    }
  }

  app.get('/guilds/:id/treasury', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    return treasuryRoute(c, async () => c.json(await deps.treasury.overview(who.guild)))
  })

  for (const [path, read] of [
    ['entries', (g: string, p: { after?: number; limit: number }) => deps.treasury.entries(g, p)],
    ['spends', (g: string, p: { after?: number; limit: number }) => deps.treasury.spends(g, p)],
  ] as const) {
    app.get(`/guilds/:id/treasury/${path}`, async (c) => {
      const who = await archiveCaller(c)
      if (who instanceof Response) {
        return who
      }
      const page = treasuryPage.safeParse({
        after: c.req.query('after'),
        limit: c.req.query('limit'),
      })
      if (!page.success) {
        return c.json({ error: 'invalid_page' }, 400)
      }
      return treasuryRoute(c, async () =>
        c.json(
          await read(who.guild, {
            limit: page.data.limit,
            ...(page.data.after ? { after: Number(page.data.after) } : {}),
          })
        )
      )
    })
  }

  app.get('/guilds/:id/treasury/verify', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    return treasuryRoute(c, async () => c.json(await deps.treasury.verify(who.guild)))
  })

  app.post('/guilds/:id/treasury/revenue', async (c) => {
    const who = await treasuryWriter(c)
    if ('res' in who) {
      return who.res
    }
    const body = revenueBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return treasuryRoute(c, async () => {
      const result = await deps.treasury.recordRevenue(who.guild, {
        ...body.data,
        actorMember: who.memberId,
      })
      return result.ok
        ? c.json({ entries: result.entries }, result.created ? 201 : 200)
        : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
    })
  })

  app.post('/guilds/:id/treasury/spends', async (c) => {
    const who = await treasuryWriter(c)
    if ('res' in who) {
      return who.res
    }
    const body = spendRequestBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return treasuryRoute(c, async () => {
      const result = await deps.treasury.requestSpend(who.guild, {
        ...body.data,
        requestedBy: who.memberId,
      })
      return result.ok
        ? c.json(result.spend, result.created ? 201 : 200)
        : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
    })
  })

  app.post('/guilds/:id/treasury/spends/:spendId/approve', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (!isGuildMaster(check.principal)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const id = uuid.safeParse(c.req.param('spendId'))
    if (c.req.param('id') !== check.guildId || !id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    return treasuryRoute(c, async () => {
      const result = await deps.treasury.approveSpend(
        check.guildId,
        id.data,
        check.principal.memberId
      )
      return result.ok
        ? c.json(result.spend)
        : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
    })
  })

  for (const verb of ['deny', 'release'] as const) {
    app.post(`/guilds/:id/treasury/spends/:spendId/${verb}`, async (c) => {
      const who = await treasuryWriter(c)
      if ('res' in who) {
        return who.res
      }
      const id = uuid.safeParse(c.req.param('spendId'))
      if (!id.success) {
        return c.json({ error: 'not_found' }, 404)
      }
      return treasuryRoute(c, async () => {
        const result =
          verb === 'deny'
            ? await deps.treasury.denySpend(who.guild, id.data, who.memberId)
            : await deps.treasury.releaseSpend(who.guild, id.data, who.memberId)
        return result.ok
          ? c.json(result.spend)
          : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
      })
    })
  }

  app.post('/guilds/:id/treasury/spends/:spendId/settle', async (c) => {
    const who = await treasuryWriter(c)
    if ('res' in who) {
      return who.res
    }
    const id = uuid.safeParse(c.req.param('spendId'))
    const body = settleBody.safeParse(await c.req.json().catch(() => null))
    if (!id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return treasuryRoute(c, async () => {
      const result = await deps.treasury.settleSpend(
        who.guild,
        id.data,
        body.data.actualCents,
        who.memberId
      )
      return result.ok
        ? c.json(result.spend)
        : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
    })
  })

  // The reserve is released only by the Guild Master, with a fresh re-authentication.
  app.post('/guilds/:id/treasury/reserve/release', async (c) => {
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (!isGuildMaster(check.principal)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    if (c.req.param('id') !== check.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    const body = reserveReleaseBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return treasuryRoute(c, async () => {
      const result = await deps.treasury.releaseReserve(check.guildId, {
        ...body.data,
        actorMember: check.principal.memberId,
      })
      return result.ok
        ? c.json({ entries: result.entries }, result.created ? 201 : 200)
        : c.json({ error: result.reason }, REFUSAL_STATUS[result.reason])
    })
  })

  // Weekly learning suggestions. Reads follow `callerGuild`; scan, accept and dismiss need a real
  // Guild Master session (agents have none). Scanning is the hook a weekly Schedule calls (a plain
  // call with no state in the process); no route or step here calls a model.
  const learningPage = z.object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SUGGESTION_PAGE).default(50),
    status: z.enum(['pending', 'accepted', 'dismissed']).optional(),
  })

  app.get('/guilds/:id/learning/suggestions', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = learningPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      status: c.req.query('status'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const { after, limit, status } = page.data
    return c.json(
      await deps.learning.list(who.guild, {
        limit,
        ...(after === undefined ? {} : { after }),
        ...(status === undefined ? {} : { status }),
      })
    )
  })

  app.post('/guilds/:id/learning/scan', async (c) => {
    const who = await treasuryWriter(c)
    if ('res' in who) {
      return who.res
    }
    // Barred guilds are refused before anything is resolved or read (the engine checks too).
    const gates = await deps.gates.status(who.guild)
    if (gates.guild || gates.global) {
      return c.json({ error: 'gates_barred' }, 409)
    }
    return treasuryRoute(c, async () => {
      try {
        return c.json(await deps.learning.scan(who.guild))
      } catch (error) {
        if (error instanceof GatesBarredError) {
          return c.json({ error: 'gates_barred' }, 409)
        }
        throw error
      }
    })
  })

  for (const verb of ['accept', 'dismiss'] as const) {
    app.post(`/guilds/:id/learning/suggestions/:suggestionId/${verb}`, async (c) => {
      const who = await treasuryWriter(c)
      if ('res' in who) {
        return who.res
      }
      const id = uuid.safeParse(c.req.param('suggestionId'))
      if (!id.success) {
        return c.json({ error: 'not_found' }, 404)
      }
      const result =
        verb === 'accept'
          ? await deps.learning.accept(who.guild, id.data)
          : await deps.learning.dismiss(who.guild, id.data)
      if (!result.ok) {
        return result.reason === 'not_found'
          ? c.json({ error: 'not_found' }, 404)
          : c.json({ error: result.reason }, 409)
      }
      return c.json({ suggestion: result.suggestion })
    })
  }

  return app
}
