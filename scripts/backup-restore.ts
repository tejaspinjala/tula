/**
 * Backup and restore of a Guildhall stack: Postgres as a `pg_dump` custom-format archive, object
 * storage as a verified copy of every object, the KEY_FILE master key to a separate directory.
 * Postgres tools run inside the Postgres container (`docker exec`), so the host needs none.
 */
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { S3Client } from 'bun'
import postgres from 'postgres'
import { z } from 'zod'

/** The database and bucket a backup reads from or a restore writes to. */
export interface Target {
  database: string
  bucket: string
}

/** How to reach the stack: `databaseUrl` names the cluster (its database part is ignored). */
export interface Connection {
  databaseUrl: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
}

const REGION = 'us-east-1'
const EXEC_TIMEOUT_MS = 10 * 60_000

const Manifest = z.object({
  createdAt: z.string(),
  database: z.string(),
  bucket: z.string(),
  dumpSha256: z.string(),
  objects: z.array(z.object({ key: z.string(), sha256: z.string(), size: z.number() })),
})

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

/** True when `child` is `parent` or lies inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Throws unless the key directory and the backup directory are disjoint (neither contains the other). */
export function assertKeySeparated(backupDir: string, keyDir: string): void {
  const a = resolve(backupDir)
  const b = resolve(keyDir)
  if (isWithin(a, b) || isWithin(b, a)) {
    throw new Error('BACKUP_KEY_DIR and BACKUP_DIR must not contain one another')
  }
}

/** Validates a SQL identifier and quotes it; names are generated or operator-supplied. */
export function ident(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) {
    throw new Error(`unsafe name: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

function clusterUrl(c: Connection, database: string): string {
  const url = new URL(c.databaseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function run(cmd: string[], stdin?: Bun.BunFile): Promise<Uint8Array> {
  const proc = Bun.spawn(cmd, {
    stdin: stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: EXEC_TIMEOUT_MS,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(' ')} failed (exit ${code}): ${err.trim()}`)
  }
  return out
}

/**
 * Finds the Postgres container: `PG_CONTAINER` if set, else the one publishing the cluster's host
 * port, so it works for the compose stack and for CI service containers alike.
 */
async function pgContainer(c: Connection): Promise<string> {
  if (process.env.PG_CONTAINER) {
    return process.env.PG_CONTAINER
  }
  const port = new URL(c.databaseUrl).port || '5432'
  const names = new TextDecoder()
    .decode(await run(['docker', 'ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']))
    .split('\n')
    .filter(Boolean)
  const [first] = names
  if (!first || names.length > 1) {
    throw new Error(
      `expected one container publishing port ${port}, found ${names.length}; set PG_CONTAINER`
    )
  }
  return first
}

type S3Access = { endpoint: string; accessKeyId: string; secretAccessKey: string }

function s3(c: S3Access, bucket: string): S3Client {
  return new S3Client({
    endpoint: c.endpoint,
    bucket,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    region: REGION,
  })
}

async function listKeys(client: S3Client): Promise<string[]> {
  const keys: string[] = []
  let startAfter: string | undefined
  for (;;) {
    const page = await client.list(startAfter ? { startAfter } : {})
    const batch = (page.contents ?? []).map((o) => o.key)
    keys.push(...batch)
    const last = batch[batch.length - 1]
    if (!page.isTruncated || !last) {
      return keys
    }
    startAfter = last
  }
}

/**
 * Writes `guildhall.dump` (pg_dump custom format), `objects/<key>` for every object in the bucket
 * and a `manifest.json` of SHA-256 hashes to `outDir`. Does not include the master key.
 */
export async function backup(options: Connection & Target & { outDir: string }): Promise<void> {
  const { outDir } = options
  await mkdir(join(outDir, 'objects'), { recursive: true })
  const container = await pgContainer(options)
  const user = decodeURIComponent(new URL(options.databaseUrl).username)
  const dump = await run([
    'docker',
    'exec',
    container,
    'pg_dump',
    '-Fc',
    '-U',
    user,
    '-d',
    options.database,
  ])
  await writeFile(join(outDir, 'guildhall.dump'), dump)

  const client = s3(options, options.bucket)
  const objects: z.infer<typeof Manifest>['objects'] = []
  for (const key of await listKeys(client)) {
    const bytes = await client.file(key).bytes()
    await mkdir(dirname(join(outDir, 'objects', key)), { recursive: true })
    await writeFile(join(outDir, 'objects', key), bytes)
    objects.push({ key, sha256: sha256(bytes), size: bytes.byteLength })
  }
  const manifest: z.infer<typeof Manifest> = {
    createdAt: new Date().toISOString(),
    database: options.database,
    bucket: options.bucket,
    dumpSha256: sha256(dump),
    objects,
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/**
 * Rebuilds a scratch database and bucket from a backup directory. Refuses to touch an existing
 * database, verifies every hash in the manifest before writing, and drops the half-built database
 * if the restore fails.
 */
export async function restore(options: Connection & Target & { inDir: string }): Promise<void> {
  const manifest = Manifest.parse(
    JSON.parse(await readFile(join(options.inDir, 'manifest.json'), 'utf8'))
  )
  const dumpPath = join(options.inDir, 'guildhall.dump')
  if (sha256(await readFile(dumpPath)) !== manifest.dumpSha256) {
    throw new Error('guildhall.dump does not match the manifest')
  }
  const objects: { key: string; bytes: Uint8Array }[] = []
  for (const entry of manifest.objects) {
    const bytes = await readFile(join(options.inDir, 'objects', entry.key))
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`object ${entry.key} does not match the manifest`)
    }
    objects.push({ key: entry.key, bytes })
  }

  const container = await pgContainer(options)
  const user = decodeURIComponent(new URL(options.databaseUrl).username)
  const admin = postgres(clusterUrl(options, 'postgres'), { max: 1, onnotice: () => {} })
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${options.database}`
    if (exists) {
      throw new Error(`database ${options.database} already exists; restore only into a new one`)
    }
    await admin.unsafe(`create database ${ident(options.database)}`)
    try {
      await run(
        [
          'docker',
          'exec',
          '-i',
          container,
          'pg_restore',
          '-U',
          user,
          '-d',
          options.database,
          '--no-owner',
          '--exit-on-error',
        ],
        Bun.file(dumpPath)
      )
    } catch (error) {
      await admin.unsafe(`drop database if exists ${ident(options.database)} with (force)`)
      throw error
    }
  } finally {
    await admin.end()
  }

  const res = await bucketRequest(options, options.bucket, 'PUT')
  if (!res.ok && !(await res.text()).includes('BucketAlreadyOwnedByYou')) {
    throw new Error(`could not create bucket ${options.bucket}: ${res.status}`)
  }
  const client = s3(options, options.bucket)
  for (const { key, bytes } of objects) {
    await client.write(key, bytes)
  }
}

/** Copies the master key file to `dir` (0700) as `master.key` (0600): keep it apart from the data backup. */
export async function backupKey(keyPath: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, 'master.key')
  await copyFile(keyPath, target)
  await chmod(target, 0o600)
}

/** Puts the backed-up master key at `keyPath` (0600); never overwrites an existing key. */
export async function restoreKey(dir: string, keyPath: string): Promise<void> {
  if ((await readdir(dir)).join() !== 'master.key') {
    throw new Error(`${dir} must hold exactly master.key`)
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
  await writeFile(keyPath, await readFile(join(dir, 'master.key')), { mode: 0o600, flag: 'wx' })
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher('sha256', key).update(data).digest())
}

/** Sends one SigV4-signed, path-style bucket request (Bun's S3 client can neither create nor delete buckets). */
async function bucketRequest(
  c: S3Access,
  bucket: string,
  method: 'PUT' | 'DELETE'
): Promise<Response> {
  const host = new URL(c.endpoint).host
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = now.slice(0, 8)
  const payloadHash = sha256(new Uint8Array())
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [
    method,
    `/${bucket}`,
    '',
    `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${now}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${day}/${REGION}/s3/aws4_request`
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha256(new TextEncoder().encode(canonical))}`
  let key = hmac(`AWS4${c.secretAccessKey}`, day)
  for (const part of [REGION, 's3', 'aws4_request']) {
    key = hmac(key, part)
  }
  const signature = new Bun.CryptoHasher('sha256', key).update(toSign).digest('hex')
  return fetch(`${c.endpoint.replace(/\/$/, '')}/${bucket}`, {
    method,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': now,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(10_000),
  })
}

/** Empties and deletes a bucket (drill cleanup). A missing bucket is fine. */
export async function removeBucket(c: S3Access & { bucket: string }): Promise<void> {
  const client = s3(c, c.bucket)
  for (const key of await listKeys(client).catch(() => [])) {
    await client.delete(key)
  }
  const res = await bucketRequest(c, c.bucket, 'DELETE')
  if (!res.ok && res.status !== 404) {
    throw new Error(`could not delete bucket ${c.bucket}: ${res.status}`)
  }
}
