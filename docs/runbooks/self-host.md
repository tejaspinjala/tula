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
`WEBAUTHN_ORIGIN=http://localhost:<PORT>` (8787) and `WEBAUTHN_RP_ID=localhost`. It derives
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
| `WEB_DIST` | unset | optional | Path to `apps/web/dist`; must exist and hold `index.html`, else boot fails. Unset: API only. |
| `KEY_FILE` | `.guildhall/master.key` | required | Audit-chain master key file (created 0600 if missing outside production). Back it up separately. |
| `CHECKPOINT_DIR` | `.guildhall/checkpoints` | required | Signed audit-chain checkpoints; use storage the database host cannot rewrite. |
| `DISPATCH_INTERVAL_MS` | unset | optional | Milliseconds between dispatch passes; unset turns the in-process loop off. |
| `TRUST_PROXY` | `false` | set to `true` behind exactly one proxy | Key rate limits on the last `X-Forwarded-For` hop. |
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
| `EGRESS_PROXY_URL` | none | with `docker` | Where a sandbox finds the egress proxy. |
| `SANDBOX_GATEWAY_URL` | none | with `docker`, must be `https` | The one origin sandboxes reach through the proxy. |
| `SUBSCRIPTION_PROVIDER` | disabled | leave disabled on hosted | `enabled` allows a `subscription` provider (see Models; built in #64). |

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

Open `http://localhost:8787`, found the guild (name and goal). The response carries a one-time
founding token (only its hash is kept); use it to register the Guild Master's first passkey. Sign
in with that passkey afterwards. Sensitive actions (Vault writes, widening config, lifting Gates)
ask for re-authentication with the passkey.

## Models: adding a provider

Open the Vault and add a provider key once; it is envelope-encrypted and only the gateway can
resolve it. Then reference the provider in the guild config.

Subscription: a `subscription` provider runs the unmodified `claude` CLI signed in on this Mac
(ADR-0008); Guildhall never reads or stores the OAuth token. It is off unless
`SUBSCRIPTION_PROVIDER=enabled` is set for guildd. Run `claude` once on the host and sign in
first. The provider is built in ticket #64; see it for the exact configuration.

## Summon

In the web app, choose a profile and Summon the guild's agents (`POST /guilds/:id/summon`; status
at `GET` on the same path). Quests then run through the dispatcher on `DISPATCH_INTERVAL_MS` or
`POST /guilds/:id/dispatch`. Seals, the Treasury and caps govern what they may do.

## Bar the Gates

The kill switch. In the web app, "Bar the Gates" stops all model calls and runs for this guild in
one step; lifting needs passkey re-authentication. The global bar and lift (`/gates/bar`,
`/gates/lift`) are only for members listed in `PLATFORM_OPERATORS`.
