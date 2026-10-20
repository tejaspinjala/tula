/**
 * `bun run start:selfhost`: checks the compose stack is reachable, migrates, builds the web app
 * and starts guildd serving it at one origin (default http://localhost:8787). Secrets come from
 * the caller's environment only; nothing is stored here, and every wait has a deadline.
 */
import { join, resolve } from 'node:path'
import { z } from 'zod'

const DEFAULT_PORT = 8787
const REACH_DEADLINE_MS = 30_000
const MIGRATE_DEADLINE_MS = 120_000
const BUILD_DEADLINE_MS = 300_000

const inputSchema = z.object({
  /** Owner connection used for migrations; its host and port locate the compose Postgres. */
  DATABASE_URL: z.url(),
  /** Password the migration gives the non-owner `guildhall_app` role guildd connects as. */
  APP_DB_PASSWORD: z.string().min(1),
  OBJECT_STORE_ACCESS_KEY: z.string().min(1),
  OBJECT_STORE_SECRET_KEY: z.string().min(1),
  OBJECT_STORE_ENDPOINT: z.url().default('http://localhost:9000'),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
})

/** What start:selfhost will run: where the stack should be, and guildd's environment. */
export interface SelfhostPlan {
  databaseHost: { host: string; port: number }
  objectStoreHost: { host: string; port: number }
  /** Environment for the migration step. */
  migrate: Record<string, string | undefined>
  /** Environment for guildd. */
  guildd: Record<string, string | undefined> & {
    WEB_DIST: string
    WEBAUTHN_ORIGIN: string
    WEBAUTHN_RP_ID: string
    APP_DATABASE_URL: string
  }
}

function hostPort(raw: string, fallbackPort: number) {
  const url = new URL(raw)
  return { host: url.hostname, port: url.port ? Number(url.port) : fallbackPort }
}

/**
 * Builds the plan from the caller's environment and the repo root. Throws naming every missing or
 * invalid setting; it never invents a secret.
 */
export function selfhostPlan(
  source: Record<string, string | undefined>,
  root: string
): SelfhostPlan {
  const parsed = inputSchema.safeParse(source)
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`start:selfhost needs these set in the environment: ${names}`)
  }
  const input = parsed.data
  const appUrl = new URL(input.DATABASE_URL)
  appUrl.username = 'guildhall_app'
  appUrl.password = input.APP_DB_PASSWORD
  return {
    databaseHost: hostPort(input.DATABASE_URL, 5432),
    objectStoreHost: hostPort(input.OBJECT_STORE_ENDPOINT, 80),
    migrate: { ...source },
    guildd: {
      ...source,
      APP_DATABASE_URL: appUrl.toString(),
      PORT: String(input.PORT),
      WEB_DIST: join(root, 'apps/web/dist'),
      WEBAUTHN_ORIGIN: `http://localhost:${input.PORT}`,
      WEBAUTHN_RP_ID: 'localhost',
    },
  }
}

/** True when a TCP connection to `host:port` succeeds within `deadlineMs`. */
export async function isReachable(host: string, port: number, deadlineMs: number) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const ok = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), Math.min(remaining, 1000))
      Bun.connect({
        hostname: host,
        port,
        socket: {
          data() {},
          open(socket) {
            clearTimeout(timer)
            socket.end()
            done(true)
          },
          connectError() {
            clearTimeout(timer)
            done(false)
          },
        },
      }).catch(() => {
        clearTimeout(timer)
        done(false)
      })
    })
    if (ok) {
      return true
    }
    await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())))
  }
  return false
}

async function step(
  label: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeout: number
) {
  process.stdout.write(`${label}...\n`)
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'inherit', stderr: 'inherit', timeout })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${label} failed (exit ${code}${proc.killed ? ', deadline exceeded' : ''})`)
  }
}

async function main() {
  const root = resolve(import.meta.dir, '..')
  const plan = selfhostPlan(process.env, root)
  for (const [name, target] of [
    ['Postgres', plan.databaseHost],
    ['object store', plan.objectStoreHost],
  ] as const) {
    if (!(await isReachable(target.host, target.port, REACH_DEADLINE_MS))) {
      throw new Error(
        `${name} is not reachable at ${target.host}:${target.port}; start it with \`docker compose up -d\``
      )
    }
  }
  await step('Migrating', ['bun', 'run', 'db:migrate'], root, plan.migrate, MIGRATE_DEADLINE_MS)
  await step(
    'Building the web app',
    ['bun', 'run', '--cwd', 'apps/web', 'build'],
    root,
    process.env,
    BUILD_DEADLINE_MS
  )
  process.stdout.write(`Guildhall at ${plan.guildd.WEBAUTHN_ORIGIN}\n`)
  const guildd = Bun.spawn(['bun', 'apps/guildd/src/main.ts'], {
    cwd: root,
    env: plan.guildd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => guildd.kill(signal))
  }
  process.exit(await guildd.exited)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'start:selfhost failed'}\n`)
    process.exit(1)
  })
}
