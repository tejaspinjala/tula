import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DockerSandboxRunner } from '../src/adapters/docker-sandbox-runner'
import { MemoryGateStore } from '../src/adapters/memory-gate-store'
import { Gates } from '../src/gates'
import { PINNED_BUN_IMAGE } from '../src/sandbox-spec'
import { docker, type EgressStack, startEgressStack, TestNetworks } from './docker-fixture'

const networks = new TestNetworks()
let stack: EgressStack
let runner: DockerSandboxRunner
const guildId = crypto.randomUUID()
let sandboxId = ''

beforeAll(async () => {
  await networks.create()
  stack = await startEgressStack(networks)
  runner = new DockerSandboxRunner({
    image: PINNED_BUN_IMAGE,
    network: networks.sandbox,
    scope: networks.tag,
    command: ['sleep', '300'],
    extraLabels: { 'guildhall.test': networks.tag },
    env: { HTTP_PROXY: stack.proxyUrl, HTTPS_PROXY: stack.proxyUrl },
  })
  const sandbox = await runner.start(guildId, {
    questId: 'q-egress',
    runToken: 'run-token-value',
    leaseHandle: 'lease-handle-value',
  })
  sandboxId = sandbox.sandboxId
}, 120_000)
afterAll(() => networks.cleanup())

/** Runs a Bun script inside the sandbox; returns what it printed and its exit code. */
async function inside(script: string) {
  return docker(['exec', sandboxId, 'bun', '-e', script])
}

describe('sandbox hardening, checked from inside', () => {
  test('runs without capabilities, without new privileges, as a non-root user', async () => {
    const status = await docker(['exec', sandboxId, 'cat', '/proc/self/status'])
    expect(status.stdout).toMatch(/^CapEff:\s+0{16}$/m)
    expect(status.stdout).toMatch(/^CapBnd:\s+0{16}$/m)
    expect(status.stdout).toMatch(/^NoNewPrivs:\s+1$/m)
    const uid = await docker(['exec', sandboxId, 'id', '-u'])
    expect(Number(uid.stdout)).toBeGreaterThan(0)
  })

  test('has a read-only root and a writable per-run tmpfs only', async () => {
    const root = await docker(['exec', sandboxId, 'touch', '/usr/local/blocked'])
    expect(root.code).not.toBe(0)
    const tmp = await docker(['exec', sandboxId, 'touch', '/tmp/ok'])
    expect(tmp.code).toBe(0)
    const inspected = await docker([
      'inspect',
      sandboxId,
      '--format',
      '{{json .Mounts}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Binds}}',
    ])
    const [mounts, ports, binds] = inspected.stdout.split('|')
    expect(mounts).toBe('[]')
    expect(ports).toBe('{}')
    expect(binds).toBe('null')
  })

  test('gets its token and lease handle, and no provider key or Vault handle', async () => {
    const env = await docker(['exec', sandboxId, 'env'])
    expect(env.stdout).toContain('GUILDHALL_RUN_TOKEN=run-token-value')
    expect(env.stdout).toContain('GUILDHALL_LEASE_HANDLE=lease-handle-value')
    expect(env.stdout).not.toMatch(/API_KEY|VAULT|SECRET|DATABASE_URL|KEY_FILE/i)
    // Tokens travel on stdin, never on the docker command line the host's process list shows.
    const inspected = await docker([
      'inspect',
      sandboxId,
      '--format',
      '{{json .Path}}{{json .Args}}',
    ])
    expect(inspected.stdout).not.toContain('run-token-value')
  })
})

describe('sandbox egress', () => {
  test('a direct fetch to the internet fails', async () => {
    const direct = await inside(
      "delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY; try { await fetch('http://1.1.1.1/', { proxy: undefined, signal: AbortSignal.timeout(4000) }); console.log('REACHED') } catch { console.log('BLOCKED') }"
    )
    expect(direct.stdout).toBe('BLOCKED')
  })

  test('a direct TCP connection to the gateway, by name or address, fails', async () => {
    const connect = (host: string) =>
      inside(
        `try { await Promise.race([Bun.connect({ hostname: '${host}', port: 8080, socket: { data() {} } }), Bun.sleep(3000).then(() => { throw new Error('timeout') })]); console.log('REACHED') } catch { console.log('BLOCKED') }`
      )
    const [byName, byAddress] = await Promise.all([
      connect(stack.gatewayHost),
      connect(stack.gatewayIp),
    ])
    expect(byName.stdout).toBe('BLOCKED')
    expect(byAddress.stdout).toBe('BLOCKED')
  }, 15_000)

  test('the gateway host answers through the egress proxy', async () => {
    const via = await inside(
      `const r = await fetch('${stack.gatewayUrl}', { signal: AbortSignal.timeout(8000) }); console.log(await r.text())`
    )
    expect(via.stdout).toBe('gateway-ok')
  })

  test('the allowed host on any other port is refused by the proxy', async () => {
    const refused = await inside(
      `const r = await fetch('http://${stack.gatewayHost}:8081/', { signal: AbortSignal.timeout(8000) }); console.log(r.status)`
    )
    expect(refused.stdout).toBe('403')
  })

  test('a host off the allowlist is refused by the proxy', async () => {
    const refused = await inside(
      "const r = await fetch('http://example.com/', { signal: AbortSignal.timeout(8000) }); console.log(r.status)"
    )
    expect(refused.stdout).toBe('403')
  })
})

describe('Bar the Gates', () => {
  test('a running sandbox is gone within 2 s of barring', async () => {
    const gates = new Gates({
      store: new MemoryGateStore(),
      runs: { revokeGuildRuns: async () => 0, revokeAllRuns: async () => 0 },
      sandboxes: runner,
      quests: { releaseLeases: async () => 0, releaseAllLeases: async () => 0 },
      guildIds: async () => [guildId],
    })
    expect(await runner.list(guildId)).toHaveLength(1)
    const started = performance.now()
    const outcome = await gates.bar({ guildId, memberId: 'guild-master' }, 'guild')
    const elapsed = performance.now() - started
    expect(outcome.killedSandboxes).toBe(1)
    expect(await runner.list(guildId)).toEqual([])
    const gone = await docker(['ps', '-aq', '--filter', `name=${sandboxId}`])
    expect(gone.stdout).toBe('')
    process.stdout.write(`bar-to-gone: ${Math.round(elapsed)} ms\n`)
    expect(elapsed).toBeLessThan(2000)
  })
})
