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
  }
}
