import { expect, test } from 'bun:test'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const IMAGE = /cgr\.dev\/chainguard\/minio\S*/

async function minioImage(file: string): Promise<string> {
  const text = await Bun.file(join(root, file)).text()
  const match = IMAGE.exec(text)
  if (!match) {
    throw new Error(`no MinIO image found in ${file}`)
  }
  return match[0]
}

test('CI starts the same MinIO image as docker-compose.yml', async () => {
  expect(await minioImage('.github/workflows/ci.yml')).toBe(await minioImage('docker-compose.yml'))
})
