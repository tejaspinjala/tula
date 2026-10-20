import { PINNED_BUN_IMAGE } from '../src/sandbox-spec'

/** The result of one `docker` call from a test. */
export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** Runs `docker` with `args` and reads the real exit code. */
export async function docker(args: string[], stdin?: string): Promise<Ran> {
  const proc = Bun.spawn(['docker', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

/** A throwaway internal network named for this test run; removes itself with {@link cleanup}. */
export class TestNetworks {
  /** Unique per test file run, so parallel runs never share containers or networks. */
  readonly tag = crypto.randomUUID().slice(0, 8)
  readonly sandbox = `gh-test-sbx-${this.tag}`
  readonly egress = `gh-test-egress-${this.tag}`
  readonly label = `guildhall.test=${this.tag}`
  /** Images built for this run; removed by {@link cleanup}. */
  readonly images: string[] = []

  /** Creates the internal sandbox network (no route out) and the egress network. */
  async create(): Promise<void> {
    for (const args of [
      ['network', 'create', '--internal', '--label', this.label, this.sandbox],
      ['network', 'create', '--label', this.label, this.egress],
    ]) {
      const made = await docker(args)
      if (made.code !== 0) {
        throw new Error(`docker network create failed: ${made.stderr}`)
      }
    }
  }

  /** Removes every container, network and volume this run created. */
  async cleanup(): Promise<void> {
    const ids = await docker(['ps', '-aq', '--filter', `label=${this.label}`])
    if (ids.stdout !== '') {
      await docker(['rm', '-f', '-v', ...ids.stdout.split('\n')])
    }
    await docker(['network', 'rm', this.sandbox, this.egress])
    for (const image of this.images) {
      await docker(['image', 'rm', image])
    }
  }
}

/** Runs `docker` and throws on a non-zero exit, returning trimmed stdout. */
export async function dockerOk(args: string[], stdin?: string): Promise<string> {
  const ran = await docker(args, stdin)
  if (ran.code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${ran.stderr}`)
  }
  return ran.stdout
}

/** Waits until the container's log shows `line`, up to `timeoutMs`. */
async function waitForLog(name: string, line: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = await docker(['logs', name])
    if (`${logs.stdout}\n${logs.stderr}`.includes(line)) {
      return
    }
    await Bun.sleep(150)
  }
  throw new Error(`${name} never logged "${line}"`)
}

/** A running egress proxy and a stand-in gateway behind it. */
export interface EgressStack {
  /** Where sandboxes find the proxy (a name on the internal sandbox network). */
  proxyUrl: string
  /** The one allowed host; reachable only through the proxy. */
  gatewayUrl: string
  /** The gateway's name and address on the egress network, for proving a direct path is closed. */
  gatewayHost: string
  gatewayIp: string
}

/**
 * Builds the egress proxy image from the repo's Dockerfile and starts it on both networks, with a
 * stand-in gateway reachable only on the egress network. All of it is labelled for cleanup.
 */
export async function startEgressStack(nets: TestNetworks): Promise<EgressStack> {
  const image = `guildhall-egress-proxy:test-${nets.tag}`
  const root = new URL('../../../', import.meta.url).pathname
  await dockerOk([
    'build',
    '--quiet',
    '--label',
    nets.label,
    '-f',
    `${root}docker/egress-proxy.Dockerfile`,
    '-t',
    image,
    root,
  ])
  nets.images.push(image)
  const gateway = `gateway-${nets.tag}`
  const proxy = `egress-${nets.tag}`
  await dockerOk([
    'run',
    '--detach',
    '--name',
    gateway,
    '--label',
    nets.label,
    '--network',
    nets.egress,
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    PINNED_BUN_IMAGE,
    'bun',
    '-e',
    "Bun.serve({ port: 8080, fetch: () => new Response('gateway-ok') }); console.log('serving')",
  ])
  await dockerOk([
    'run',
    '--detach',
    '--name',
    proxy,
    '--label',
    nets.label,
    '--network',
    nets.egress,
    '--env',
    `EGRESS_ALLOWED_HOSTS=${gateway}:8080`,
    image,
  ])
  await dockerOk(['network', 'connect', nets.sandbox, proxy])
  await waitForLog(gateway, 'serving')
  await waitForLog(proxy, 'egress-proxy listening')
  const gatewayIp = await dockerOk([
    'inspect',
    gateway,
    '--format',
    `{{(index .NetworkSettings.Networks "${nets.egress}").IPAddress}}`,
  ])
  return {
    proxyUrl: `http://${proxy}:3128`,
    gatewayUrl: `http://${gateway}:8080/`,
    gatewayHost: gateway,
    gatewayIp,
  }
}
