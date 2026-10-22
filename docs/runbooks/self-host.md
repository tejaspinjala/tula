# Self-hosting Guildhall

One Guild Master, one Mac, one URL: `http://localhost:8787`. guildd serves the built web app and
its API at the same origin (the API under `/api`, the un-prefixed routes still work), so there is
no dev server, no CORS, and passkeys work on `localhost` (ADR-0007).

## Start

1. Start the stack: `docker compose up -d` (Postgres and MinIO; set `POSTGRES_PORT` first if 5432
   is taken, for example `POSTGRES_PORT=55432`).
2. Export the secrets (the script stores none): `DATABASE_URL`, `APP_DB_PASSWORD`,
   `OBJECT_STORE_ACCESS_KEY`, `OBJECT_STORE_SECRET_KEY`. `DATABASE_URL` names the owner
   connection, so its port is the one the stack publishes (`POSTGRES_PORT`).
3. `bun run start:selfhost`.

The command checks Postgres and the object store are reachable (30 s deadline each), migrates
(120 s), builds the web app (300 s), then starts guildd with `WEB_DIST=apps/web/dist`,
`WEBAUTHN_ORIGIN=http://localhost:<PORT>` (8787), `WEBAUTHN_RP_ID=localhost` and
`FOUNDING_MODE=once` (unless you set it; see Reach it through a Cloudflare Tunnel). It derives
`APP_DATABASE_URL` from `DATABASE_URL` and `APP_DB_PASSWORD` (user `guildhall_app`). Anything else
below is passed through from your environment. First boot: set `OBJECT_STORE_CREATE_BUCKET=true`.

## Environment

"Production" means `NODE_ENV=production`, where the marked settings must be set explicitly.

### guildd (`apps/guildd/src/env.ts`)

| Variable | Default | Production | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | set to `production` | Turns on the boot-time safety checks. |
| `APP_DATABASE_URL` | none (required) | required | Non-owner `guildhall_app` connection the app uses. |
| `OBJECT_STORE_ACCESS_KEY` | none (required) | required | S3-compatible access key. Secret. |
| `OBJECT_STORE_SECRET_KEY` | none (required) | required | S3-compatible secret key. Secret. |
| `OBJECT_STORE_ENDPOINT` | `http://localhost:9000` | set | Object storage endpoint. |
| `OBJECT_STORE_BUCKET` | `guildhall-artifacts` | set | Artifact bucket (3+ characters). |
| `OBJECT_STORE_CREATE_BUCKET` | `false` | must stay `false` | `true` creates the bucket at boot (development, first run). |
| `WEBAUTHN_RP_ID` | `localhost` | required | Domain passkeys are scoped to. |
| `WEBAUTHN_ORIGIN` | `http://localhost:5173` | required | Exact origin the web app is served from (`http://localhost:8787` self-hosted). |
| `PORT` | `8787` | set | HTTP port. |
| `HOST` | `127.0.0.1` | keep loopback unless behind a TLS proxy | Address guildd binds. See Exposing guildd. |
| `WEB_DIST` | unset | optional | Path to `apps/web/dist`; must exist and hold `index.html`, else boot fails. Unset: API only. |
| `KEY_FILE` | `.guildhall/master.key` | required | Audit-chain master key file (created 0600 if missing outside production). Back it up separately. |
| `CHECKPOINT_DIR` | `.guildhall/checkpoints` | required | Signed audit-chain checkpoints; use storage the database host cannot rewrite. |
| `DISPATCH_INTERVAL_MS` | unset (`start:selfhost`: `5000`) | optional | Milliseconds between dispatch passes; unset turns the in-process loop off. `start:selfhost` sets 5000 unless you set it. |
| `TRUST_PROXY` | `false` | set to `true` behind exactly one proxy | Key rate limits on the last `X-Forwarded-For` hop. |
| `PUBLIC_ORIGIN` | unset | optional, `start:selfhost` only | `https://` origin of the tunnel or proxy. Sets `WEBAUTHN_ORIGIN` to it, `WEBAUTHN_RP_ID` to its hostname and `TRUST_PROXY=true`; `HOST` stays `127.0.0.1`. |
| `FOUNDING_MODE` | `open` | `once` when guildd is reachable from the internet | Who may found a guild: `open` (anyone), `once` (403 `founding_closed` once any guild exists), `closed` (always 403). `start:selfhost` defaults it to `once`. |
| `DEV_GUILD_HEADER` | `false` | must be `false` | Trust `x-guild-id` as the caller (development only). |
| `VAPID_PUBLIC_KEY` | unset | required | Web push public key (base64url, 65 bytes). |
| `VAPID_PRIVATE_KEY` | unset | required | Web push private key (base64url, 32 bytes). Secret. |
| `VAPID_SUBJECT` | unset | required | `mailto:` or `https:` contact; the three VAPID settings are all-or-none. |
| `PLATFORM_OPERATORS` | empty | optional | Comma-separated member uuids allowed to bar or lift every guild. |
| `SANDBOX_RUNNER` | `memory` | must be `docker` | How sandboxes run. |
| `SANDBOX_IMAGE` | none | with `docker` | Sandbox image pinned by digest. |
| `SANDBOX_NETWORK` | none | with `docker` | Dedicated internal Docker network (not `host`, `bridge`, `none`). |
| `SANDBOX_SCOPE` | `default` | optional | Label scoping sandboxes for cleanup. |
| `SANDBOX_KILL_DEADLINE_MS` | `2000` | optional | Deadline for killing sandboxes (1 to 10000). |
| `SANDBOX_START_TIMEOUT_MS` | `10000` | optional | How long opening a run, leasing and starting its sandbox may take before the Quest is released as `timeout`. |
| `EGRESS_PROXY_URL` | none | with `docker` | Where a sandbox finds the egress proxy. |
| `SANDBOX_GATEWAY_URL` | none | with `docker`, must be `https` | The one origin sandboxes reach through the proxy. |
| `SUBSCRIPTION_PROVIDER` | disabled | leave disabled on hosted | `enabled` allows a `subscription` provider (see Models). |
| `CLAUDE_CLI_BIN` | `claude` | n/a (self-host only) | The `claude` executable the subscription provider runs. |
| `CLAUDE_CLI_TIMEOUT_MS` | `120000` | n/a (self-host only) | Milliseconds before a `claude` child is killed (1 to 3600000). |
| `CLAUDE_CLI_MAX_CONCURRENT` | `2` | n/a (self-host only) | Most `claude` children at once (1 to 32). |
| `RESEARCH_PROVIDER` | none (research off) | optional | `brave` turns on the `research` tool (ADR-0010); `memory` is development and run-checks only and is refused in production. A guild still needs `maxResearchPerQuest` above 0, which is a widening change. |
| `BRAVE_SEARCH_API_KEY` | none | with `brave` | Brave Search API token (secret). |
| `RESEARCH_PRIVATE_ELIGIBLE` | `false` | optional | `true` lets private-class Quests send queries to the provider; leave `false` unless your agreement with it allows that. |
| `RESEARCH_CALL_COST_CENTS` | `1` | optional | Paper cents the Treasury charges per research call (0 to 10000). |
| `INQUIRY_EXPIRY_DAYS` | `7` | optional | Days an Inquiry waits for its answer before the sweep expires it (1 to 90). |
| `RESEARCH_MEMORY_SEED` | none | with `memory` | JSON `{results, pages}` the memory provider serves. |

### Migrations (`apps/guildd/src/db/migrate-cli.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | Owner or migrator connection (see `migrate-deploy.md`). |
| `APP_DB_PASSWORD` | none (required) | Password given to the `guildhall_app` role. Secret. |

### Egress proxy (`apps/guildd/src/egress-proxy-main.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EGRESS_PORT` | `3128` | Port the proxy listens on. |

### Sandbox worker (`apps/guildd/src/worker-main.ts`)

Set by guildd when it starts a sandbox, never by hand: `GUILDHALL_GATEWAY_URL`,
`GUILDHALL_RUN_TOKEN` (secret, per run), `GUILDHALL_LEASE_HANDLE`, `GUILDHALL_DONE_CONDITION`.

### Backup, restore and compose

`scripts/backup.ts` and `restore.ts` read `DATABASE_URL`, `OBJECT_STORE_ENDPOINT`,
`OBJECT_STORE_ACCESS_KEY`, `OBJECT_STORE_SECRET_KEY`, `OBJECT_STORE_BUCKET`, `BACKUP_DIR`
(default `.guildhall/backups`), `KEY_FILE`, `BACKUP_KEY_DIR` and `PG_CONTAINER`
(see `backup-restore.md`). `docker-compose.yml` reads `POSTGRES_PORT` (5432), `MINIO_PORT` (9000)
and `MINIO_CONSOLE_PORT` (9001). `start:selfhost` itself reads `DATABASE_URL`, `APP_DB_PASSWORD`,
`OBJECT_STORE_*` and `PORT`.

## Founding the guild

Open `http://localhost:8787`. While you are signed out the page shows **Found your guild**: enter
the guild name and goal and press **Found your guild**. The page asks the browser to create the
Guild Master's first passkey (`POST /founding/begin`), and the guild is created only once the
passkey verifies (`POST /founding/finish`, one transaction with the passkey), then you are
signed in. If you cancel the passkey prompt nothing is written: press **Found your guild** again.
Too many attempts shows a rate-limit message; wait a minute. Later, sign in with the passkey (Passkey section, with the guild id). Sensitive actions (Vault writes, widening config, lifting Gates)
ask for re-authentication with the passkey.

## Signing in from a new device

A second laptop with no synced passkey and no live session cannot sign in on its own. Try these in
order.

1. **Phone QR (hybrid).** On the sign-in screen choose **Continue**. Your browser offers "use a
   phone or tablet": scan the QR code with the phone that holds the passkey and approve. Nothing
   changes on the server.
2. **A one-time link from the host.** If the phone is not at hand, on the machine that runs
   Guildhall (the shell there is already the trust root) run, with the same environment as
   `start:selfhost` (so `PUBLIC_ORIGIN` sets the link's origin):

   ```sh
   bun run guild:enrol-link            # the only guild
   bun run guild:enrol-link --guild <guild id>   # when the host has several
   ```

   It prints `https://<origin>/#enrol=<token>`. Open it on the new device within 15 minutes. The
   title screen clears the fragment from the address bar and offers **Join the guild on this
   device**; the device makes one passkey, you are signed in, and the link is spent. The token is
   random (128 bits or more), kept on the server only as a hash, and carried in the URL fragment,
   which browsers never send to a server and guildd never logs. A reused, expired or wrong link is
   refused with one message. Minting again replaces the earlier link. Both minting and redeeming
   are written to the audit log without any secret.

## Models: adding a provider

Open the Vault and add a provider key once; it is envelope-encrypted and only the gateway can
resolve it. Then reference the provider in the guild config.

Subscription: a `subscription` provider runs the unmodified `claude` CLI signed in on this Mac
(ADR-0008); Guildhall never reads or stores the OAuth token. It is off unless
`SUBSCRIPTION_PROVIDER=enabled` is set for guildd. Run `claude` once on the host and sign in
first. Setup, in order:

1. Set `SUBSCRIPTION_PROVIDER=enabled` for guildd.
2. Sign `claude` in on the host (run it once). `CLAUDE_CLI_BIN`, `CLAUDE_CLI_TIMEOUT_MS` and
   `CLAUDE_CLI_MAX_CONCURRENT` tune the child process.
3. In the guild config, declare the provider with `auth: 'subscription'` and give the routing
   profile that uses it a `model` (the model id lives only in routing).

## Exposing guildd

guildd binds `127.0.0.1` (`HOST`), because the founding routes (`/founding/begin` and
`/founding/finish`) are unauthenticated until a guild exists. `start:selfhost` pins `HOST=127.0.0.1`. To reach it from other machines, do
not set `HOST=0.0.0.0` bare: put a TLS reverse proxy in front, set `TRUST_PROXY=true` (exactly one
proxy), and set production WebAuthn settings (`NODE_ENV=production`, `WEBAUTHN_RP_ID` and
`WEBAUTHN_ORIGIN` for the public https origin).

## Reach it through a Cloudflare Tunnel

Do this only for yourself: anyone who can found a guild here can run Quests on your Claude plan and
Docker, and serving others through a subscription breaks Anthropic's terms (ADR-0008).

1. Install `cloudflared` and pick a tunnel.
   - Quick tunnel: `cloudflared tunnel --url http://localhost:8787`. It prints a random
     `https://<name>.trycloudflare.com` hostname that changes on every restart. Passkeys are bound
     to the hostname, so a restart strands them. Fine for a trial.
   - Named tunnel with a stable hostname (recommended if you want to keep a passkey): create it in
     your Cloudflare account and route a hostname you own to `http://localhost:8787`.
2. Start Guildhall with the tunnel's origin: `PUBLIC_ORIGIN=https://<hostname> bun run start:selfhost`.
   It must be `https://`. This sets `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` (the hostname) and
   `TRUST_PROXY=true`, forces `DEV_GUILD_HEADER=false`, keeps `HOST=127.0.0.1` (the tunnel
   connects locally) and prints the URL. `TRUST_PROXY` is only safe because guildd listens on
   loopback: nothing but the tunnel can reach it to forge the last `X-Forwarded-For` hop.
3. Found your guild right away, then leave `FOUNDING_MODE=once` (the `start:selfhost` default):
   once any guild exists founding (`/founding/finish`) answers 403 `founding_closed`. Until then founding is open
   to anyone who has the URL, and the first founder wins, so share the hostname with no one, found
   within minutes, and check that the guild you see is yours (or put Cloudflare Access in front
   first). `closed` refuses always. If you lose
   your passkey, restart with an explicit `FOUNDING_MODE=open`, re-found, then go back to `once`.
4. Optional extra gate: put Cloudflare Access in front of the hostname so only your identity
   reaches guildd at all.

## Summon

In the web app, choose a profile and Summon the guild's agents (`POST /guilds/:id/summon`; status
at `GET` on the same path). Quests then run through the dispatcher on `DISPATCH_INTERVAL_MS` or
`POST /guilds/:id/dispatch`. Seals, the Treasury and caps govern what they may do.

## Bar the Gates

The kill switch. In the web app, "Bar the Gates" stops all model calls and runs for this guild in
one step; lifting needs passkey re-authentication. The global bar and lift (`/gates/bar`,
`/gates/lift`) are only for members listed in `PLATFORM_OPERATORS`.

## Away mode and the Council

Away mode says you will not answer Seals for a while (ADR-0011). With Seal Policy `routine_alone`,
the Council of Elders may then approve a routine Proposal in your place. Nothing else changes.

**What happens while you are away.** Only when the Seal Policy is `routine_alone`, you are away,
the Proposal is routine (its Quest template is routine-eligible, its data class is not private, a
passing Verdict is bound to its exact text) and the guild is under its daily caps, the five voices
(architect, skeptic, security, ops, user) each vote. Five approvals settle the Quest as
`council_approved`; the Seal is recorded as `council_approved` and names the Council session,
never a Guild Master. Any block, abstention, failed run or spent cap sends the Proposal to a normal
Seal with the Council's reasons as evidence, and it waits for you.

**What does not happen.** A private-class Proposal goes straight to a Seal with no session. No Seal
is ever approved on your behalf, no Treasury or config limit moves, and the Council cannot widen
anything. Bar the Gates works the same while you are away: it halts a session in progress
(`council.halted`) and the Quest stays Awaiting Seal. If you return mid-vote, the Proposal takes a
normal Seal.

**Turning it on.** Away mode itself is a runtime tap in the Bag ("Away mode": Go away, optionally
until a time, and Return). It needs your signed-in session but no Seal. The Seal Policy is config:
`PUT /guilds/:id/config` with `sealPolicy` set to `routine_alone`. Raising the policy is a widening
change, so it waits until you confirm it with your passkey
(`POST /guilds/:id/config/versions/:version/confirm`). Setting it back to `always` is a narrowing
change and applies at once.

**Caps.** The Council gives at most 5 approvals and convenes at most 20 sessions per UTC day unless
the config says otherwise. Raise them with `caps.maxCouncilApprovalsPerDay` and
`caps.maxCouncilSessionsPerDay`; raising either is a widening change and needs the same passkey
confirmation. `0` approvals means the Council never approves. Lowering a cap applies at once.

**`council_unavailable`.** The reason on an escalation when the voices could not finish: the model
call failed or timed out, or the reply was unusable, after three attempts. It is not a block. The
Proposal takes a normal Seal and waits for you; check the provider key (Models: adding a provider) if it
repeats.

**`autonomous` is refused.** Seal Policy `autonomous` is not available: writing it fails with
`seal_policy_locked`, and a stored `autonomous` is read as `always`. Use `always` or
`routine_alone`.

**Reading it.** The Council panel (Council in the menu, or the elders' hall on the map) lists
sessions newest first with each voice's vote, its reasons and its cost. When you return, "While you
were away" opens once and lists Council approvals, escalations with their reason, halted sessions,
Seals still waiting, Quests done and the window's Treasury spend; read it again any time from the
Bag. Each Council line opens that session's votes. The event log (the scroll) records
`guildmaster.away`, `guildmaster.returned`, `council.convened`, `council.voted`, `council.approved`,
`council.escalated` and `council.halted`, with ids and small facts only; a Council approval also
appears as `seal.council_approved`, never as `seal.approved`.

## Private Halls

Every guild starts with three private Halls: Health, Personal and Relationships. They are locked and
have no Members. Private Halls take Quests only after you unlock one, mark a provider
private-eligible and hire a Member (ADR-0012).

**What goes where.** A private Quest (templates Health log, Personal plan and Relationship note; no
Seal needed) runs only on a private-eligible provider. If none exists it waits on the Quest Board
(it is not killed) and starts once you mark one. The Member files its result as a private note in
that Hall's own Archive. The model classifier, which reads free text, runs only on a private-eligible
provider; with none, free text simply stays private.

**Choosing a private-eligible provider.** Open Settings, Providers. Each provider shows its state and
one plain sentence saying where private text goes, for example "Private Quests would be sent to
Anthropic through your Claude subscription on this Mac". That sentence is built from the provider's
auth path and what guildd reports at `GET /guilds/:id/providers/status`; no model writes it. Turning
it on is a widening change: confirm it with your passkey. Turning it off applies at once.

**What the disclosure means.** Private-eligible does not mean the text stays on this Mac. The
Guildhall never ranks a vendor or auth path as safe; it only records your choice. Any provider kind
may be chosen, including the `claude -p` subscription (ADR-0008), whose text still reaches Anthropic.
On a hosted Guildhall subscription providers are dropped, so one never serves private work there.

**Unlocking and re-locking.** Unlock a Hall from the Hall builder (passkey) and hire Members there;
the default roster is empty. Locking it again applies at once: its live leases are released, its
running Member stops, and its Quests wait as paused with no retry attempt spent. Unlock it and they
resume. The log records `hall.locked` and `hall.unlocked`.

**What nobody else sees.** The Council never receives a private Quest, so no elder reads private
text. A Dossier, an Inquiry answer or a Bug Report never carries a private Hall's content to a work
Hall, and a work-Hall Member reading the Archive is told the note does not exist. "While you were
away" names private Quests only to you. Another guild never sees any of it.

## Desktop app

`apps/desktop` is a Tauri 2 shell: a native window that opens your Guildhall server, with the pixel-art
icon, a full-screen toggle (View menu, `Cmd+Ctrl+F`) and **Guildhall > Change Server Address...**
(`Cmd+Shift+S`). It loads the remote `https://` origin directly, so passkeys keep the tunnel hostname as
their RP ID. The address is stored in `settings.json` in the app config directory
(`~/Library/Application Support/app.guildhall.desktop/` on macOS); the first run asks for it.

Needs Rust (`rustup`) and the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`).

```sh
bun run --cwd apps/desktop dev     # run the shell
bun run --cwd apps/desktop build   # icons, then .app/.dmg under apps/desktop/src-tauri/target/release/bundle
cd apps/desktop/src-tauri && cargo test   # address validation and the settings file
```

Passkey sign-in inside the shell depends on Apple entitlements an unsigned build cannot hold; see
`docs/spikes/tauri-passkeys.md` for the decision and the system-browser hand-back. CI builds the app on
macOS only when you run the `desktop` workflow by hand.
