import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { S3ObjectStore } from '../apps/guildd/src/adapters/s3-object-store'
import { removeBucket } from './backup-restore'

// The scheduled backup services (#33): the real `backup` profile of docker-compose.yml must produce
// a pg_dump file and a mirrored object. They run in a throwaway compose project that joins the
// running stack's network (no host ports are bound) and are removed with their volume afterwards.
const root = resolve(import.meta.dir, '..')
const stackNetwork = process.env.COMPOSE_STACK_NETWORK ?? 'guildhall_default'
const endpoint = process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY ?? 'guildhall'
const secretAccessKey = process.env.OBJECT_STORE_SECRET_KEY ?? 'guildhall-dev-secret'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const project = `guildhall-backup-test-${suffix}`
const bucket = `backup-svc-${suffix}`
const work = await mkdtemp(join(tmpdir(), 'guildhall-backup-svc-'))
const override = join(work, 'override.yml')

// Reuse the running Postgres and MinIO by service name on their network, instead of starting more.
const overrideYaml = `
networks:
  default:
    name: ${stackNetwork}
    external: true
services:
  backup-postgres:
    depends_on: !override
      backup-init:
        condition: service_completed_successfully
  backup-objects:
    depends_on: !override
      backup-init:
        condition: service_completed_successfully
`

async function compose(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ['docker', 'compose', '-p', project, '-f', 'docker-compose.yml', '-f', override, ...args],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' }
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await Bun.sleep(2000)
  }
  const logs = await compose('--profile', 'backup', 'logs', '--no-color', '--tail', '20')
  throw new Error(`timed out waiting for ${what}\n${logs.out}`)
}

async function listing(service: string, dir: string): Promise<string> {
  const r = await compose('--profile', 'backup', 'exec', '-T', service, 'ls', '-1', dir)
  return r.code === 0 ? r.out.trim() : ''
}

afterAll(async () => {
  await compose('--profile', 'backup', 'down', '--volumes', '--remove-orphans', '--timeout', '1')
  await removeBucket({ endpoint, accessKeyId, secretAccessKey, bucket })
  await rm(work, { recursive: true, force: true })
})

describe('scheduled backup services', () => {
  test('write a pg_dump file and mirror an object into the backup volume', async () => {
    await writeFile(override, overrideYaml)
    const store = new S3ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey })
    await store.ensureBucket()
    await store.put(crypto.randomUUID(), new TextEncoder().encode(`object ${suffix}`))

    const up = await compose('--profile', 'backup', 'up', '-d', 'backup-postgres', 'backup-objects')
    expect(up.code).toBe(0)

    await waitFor(
      async () => (await listing('backup-postgres', '/backups/postgres')).endsWith('.dump'),
      'a pg_dump file'
    )
    await waitFor(
      async () => (await listing('backup-objects', `/backups/objects/${bucket}`)) !== '',
      'a mirrored object'
    )
    expect(await listing('backup-postgres', '/backups/postgres')).toMatch(/guildhall-.*\.dump$/)
  }, 180_000)
})
