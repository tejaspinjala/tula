import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The scheduled backup services (#33): the real `backup` profile of docker-compose.yml must produce
// a pg_dump file and a mirrored object. Everything runs in a throwaway compose project with its own
// Postgres, MinIO and volumes (no host ports bound), removed with `down --volumes` afterwards.
const root = resolve(import.meta.dir, '..')

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const project = `guildhall-backup-test-${suffix}`
const bucket = `backup-svc-${suffix}`
const work = await mkdtemp(join(tmpdir(), 'guildhall-backup-svc-'))
const override = join(work, 'override.yml')

const overrideYaml = `
services:
  postgres:
    ports: !override []
  minio:
    ports: !override []
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
  await rm(work, { recursive: true, force: true })
})

describe('scheduled backup services', () => {
  test('write a pg_dump file and mirror an object into the backup volume', async () => {
    await writeFile(override, overrideYaml)
    const stack = await compose('--profile', 'backup', 'up', '-d', '--wait', 'postgres', 'minio')
    expect(stack.code).toBe(0)
    const row = await compose(
      '--profile',
      'backup',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'guildhall',
      '-c',
      'create table backup_probe (id int); insert into backup_probe values (1)'
    )
    expect(row.code).toBe(0)
    const seed = await compose(
      '--profile',
      'backup',
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'sh',
      'backup-objects',
      '-c',
      `mc mb source/${bucket} && echo ${suffix} | mc pipe source/${bucket}/probe.txt`
    )
    expect(seed.code).toBe(0)

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
