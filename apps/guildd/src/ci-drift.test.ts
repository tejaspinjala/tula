import { expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')

// docker-compose.yml is the only place the MinIO image is pinned, so a Dependabot bump of it
// reaches CI too; a second copy in the workflow drifts on every bump.
test('CI starts MinIO from docker-compose.yml instead of pinning its own image', async () => {
  const ci = await Bun.file(join(root, '.github/workflows/ci.yml')).text()
  expect(ci).not.toMatch(/chainguard\/minio/)
  expect(ci).toMatch(/docker compose up -d --wait minio/)
})
