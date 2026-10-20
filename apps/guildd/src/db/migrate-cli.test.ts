import { describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { TEST_APP_PASSWORD, testDbUrl } from '../testing/test-db'

async function runCli(env: Record<string, string>) {
  const proc = Bun.spawn(['bun', new URL('./migrate-cli.ts', import.meta.url).pathname], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  return { code, err: await new Response(proc.stderr).text() }
}

describe('db:migrate entry', () => {
  test('fails with a clear message when APP_DB_PASSWORD is missing', async () => {
    const { code, err } = await runCli({ DATABASE_URL: testDbUrl() })
    expect(code).not.toBe(0)
    expect(err).toContain('APP_DB_PASSWORD')
  })

  test('needs only DATABASE_URL and APP_DB_PASSWORD, and the app role can then log in', async () => {
    const { code, err } = await runCli({
      DATABASE_URL: testDbUrl(),
      APP_DB_PASSWORD: TEST_APP_PASSWORD,
    })
    expect(err).toBe('')
    expect(code).toBe(0)

    const app = postgres(testDbUrl('app'), { max: 1 })
    try {
      const [row] = await app`select current_user as u`
      expect(row?.u).toBe('guildhall_app')
    } finally {
      await app.end()
    }
  })
})
