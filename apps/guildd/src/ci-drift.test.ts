import { expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')

// docker-compose.yml is the only place the MinIO image is pinned, so a Dependabot bump of it
// reaches CI too; a second copy in the CI file drifts on every bump.
test('CI starts MinIO from docker-compose.yml instead of pinning its own image', async () => {
  const [path] = await Array.fromAsync(new Bun.Glob('.github/*/ci.yml').scan({ cwd: root }))
  expect(path).toBeDefined()
  const ci = await Bun.file(join(root, path ?? '')).text()
  expect(ci).not.toMatch(/chainguard\/minio/)
  expect(ci).toMatch(/docker compose up -d --wait minio/)
})
