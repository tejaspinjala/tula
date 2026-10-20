import { describe, expect, test } from 'bun:test'
import { type HardenedSpec, hardenedRunArgs } from './sandbox-spec'

const spec: HardenedSpec = {
  image:
    'oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288',
  name: 'gh-sbx-1',
  network: 'guildhall-sandbox',
  labels: { 'guildhall.guild': 'g1', 'guildhall.run': 'r1' },
  limits: { pids: 128, memory: '512m', cpus: '1' },
  command: ['sleep', '300'],
}

/** The value following `flag`, for each time the flag appears. */
function values(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []))
}

describe('hardenedRunArgs', () => {
  test('drops privileges: non-root, no capabilities, no new privileges, read-only root', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--user')[0]).toMatch(/^[1-9]\d*:[1-9]\d*$/)
    expect(values(args, '--cap-drop')).toEqual(['ALL'])
    expect(values(args, '--security-opt')).toContain('no-new-privileges')
    expect(args).toContain('--read-only')
    expect(args).not.toContain('--privileged')
  })

  test('keeps the default seccomp profile (never unconfined)', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--security-opt').some((o) => o.startsWith('seccomp'))).toBe(false)
  })

  test('limits processes, memory and cpu', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--pids-limit')).toEqual(['128'])
    expect(values(args, '--memory')).toEqual(['512m'])
    expect(values(args, '--memory-swap')).toEqual(['512m'])
    expect(values(args, '--cpus')).toEqual(['1'])
  })

  test('mounts only a per-run tmpfs, never a host path or volume', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--tmpfs')).toHaveLength(1)
    expect(args).not.toContain('-v')
    expect(args).not.toContain('--volume')
    expect(args.some((a) => a.startsWith('--mount') || a.startsWith('--volumes-from'))).toBe(false)
  })

  test('joins only the sandbox network, publishes no port, restricts DNS', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--network')).toEqual(['guildhall-sandbox'])
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--publish')
    expect(args).not.toContain('-P')
    expect(values(args, '--dns')).toHaveLength(1)
  })

  test('labels the container and puts the image then the command last', () => {
    const args = hardenedRunArgs(spec)
    expect(values(args, '--label')).toEqual(['guildhall.guild=g1', 'guildhall.run=r1'])
    expect(args.slice(-3)).toEqual([spec.image, 'sleep', '300'])
  })

  test('ends options with -- immediately before the image', () => {
    const args = hardenedRunArgs(spec)
    expect(args.slice(-4)).toEqual(['--', spec.image, 'sleep', '300'])
  })

  test('never carries env values on the command line', () => {
    const args = hardenedRunArgs(spec)
    expect(args).not.toContain('--env')
    expect(args).not.toContain('-e')
    expect(values(args, '--env-file')).toEqual(['/dev/stdin'])
  })
})
