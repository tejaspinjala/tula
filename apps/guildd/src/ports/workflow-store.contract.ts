import { describe, expect, test } from 'bun:test'
import type { WorkflowGraph } from '../workflows/graph'
import { LEARNING_TO_LINKEDIN } from '../workflows/templates'
import type { NewWorkflowVersion, WorkflowStore } from './workflow-store'

/** A store under test and a way to get real guilds. */
export interface WorkflowStoreFixture {
  store: WorkflowStore
  newGuild: () => Promise<string>
}

const graph = (): WorkflowGraph => structuredClone(LEARNING_TO_LINKEDIN)
const version = (over: Partial<NewWorkflowVersion> = {}): NewWorkflowVersion => ({
  name: 'Learning to LinkedIn',
  graph: graph(),
  classification: 'internal',
  status: 'active',
  ...over,
})

/** The WorkflowStore contract, run against every adapter. `make` returns a fresh store. */
export function workflowStoreContract(name: string, make: () => Promise<WorkflowStoreFixture>) {
  describe(`WorkflowStore contract: ${name}`, () => {
    test('a save appends gap-free versions and keeps every graph as written', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const one = await store.saveVersion(g, 'wf', version())
      const edited = graph()
      edited.nodes = edited.nodes.map((n) => (n.id === 'start' ? { ...n, name: 'Go' } : n))
      const two = await store.saveVersion(g, 'wf', version({ graph: edited }))
      expect([one.version, two.version]).toEqual([1, 2])
      expect(one).toMatchObject({
        workflowId: 'wf',
        name: 'Learning to LinkedIn',
        status: 'active',
      })
      expect((await store.getVersion(g, 'wf', 1))?.graph).toEqual(graph())
      expect((await store.getVersion(g, 'wf'))?.graph).toEqual(edited)
      expect(await store.getVersion(g, 'wf', 3)).toBeNull()
      expect(await store.getVersion(g, 'other')).toBeNull()
    })

    test('same-tick saves never share a version number', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const saved = await Promise.all(
        Array.from({ length: 5 }, () => store.saveVersion(g, 'wf', version()))
      )
      expect(saved.map((s) => s.version).sort()).toEqual([1, 2, 3, 4, 5])
    })

    test('a pending version cannot run until activated; activation is idempotent', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await store.saveVersion(g, 'wf', version({ status: 'pending', classification: 'widening' }))
      expect((await store.latestActive(g, 'wf'))?.version).toBe(1)
      expect((await store.getVersion(g, 'wf'))?.version).toBe(2)
      const activated = await store.activate(g, 'wf', 2)
      expect(activated).toMatchObject({ version: 2, status: 'active', classification: 'widening' })
      expect((await store.activate(g, 'wf', 2))?.status).toBe('active')
      expect((await store.latestActive(g, 'wf'))?.version).toBe(2)
      expect(await store.activate(g, 'wf', 9)).toBeNull()
    })

    test('workflows list in id order, paged, with their latest and active versions', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'b-flow', version({ name: 'B' }))
      await store.saveVersion(g, 'a-flow', version({ name: 'A' }))
      await store.saveVersion(g, 'a-flow', version({ name: 'A2', status: 'pending' }))
      const first = await store.list(g, { limit: 1 })
      expect(first.workflows).toMatchObject([
        { id: 'a-flow', name: 'A2', latestVersion: 2, activeVersion: 1 },
      ])
      expect(first.next).toBe('a-flow')
      const second = await store.list(g, { after: first.next ?? '', limit: 1 })
      expect(second.workflows.map((w) => w.id)).toEqual(['b-flow'])
      expect(second.next).toBeNull()
    })

    test('seeding inserts only when no version exists, even for same-tick calls', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const seeded = await Promise.all([
        store.seedVersion(g, 'seed', version()),
        store.seedVersion(g, 'seed', version()),
      ])
      expect(seeded.filter((s) => s !== null)).toHaveLength(1)
      expect((await store.versions(g, 'seed', { limit: 10 })).versions).toHaveLength(1)
      expect(await store.seedVersion(g, 'seed', version())).toBeNull()
    })

    test('versions list newest first, paged', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (let i = 0; i < 3; i += 1) {
        await store.saveVersion(g, 'wf', version())
      }
      const first = await store.versions(g, 'wf', { limit: 2 })
      expect(first.versions.map((v) => v.version)).toEqual([3, 2])
      expect(first.next).toBe(2)
      const rest = await store.versions(g, 'wf', { before: first.next ?? 0, limit: 2 })
      expect(rest.versions.map((v) => v.version)).toEqual([1])
      expect(rest.next).toBeNull()
    })

    test('an instance is pinned to a version and one run key makes one instance', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      const first = await store.createInstance(g, { workflowId: 'wf', version: 1, runKey: 'k' })
      const again = await store.createInstance(g, { workflowId: 'wf', version: 1, runKey: 'k' })
      expect(first.created).toBe(true)
      expect(again).toEqual({ instance: first.instance, created: false })
      expect(first.instance).toMatchObject({ workflowId: 'wf', version: 1, runKey: 'k' })
      expect(await store.getInstance(g, first.instance.id)).toEqual(first.instance)
      expect(await store.getInstance(g, crypto.randomUUID())).toBeNull()
      const same = await Promise.all([
        store.createInstance(g, { workflowId: 'wf', version: 1, runKey: 'race' }),
        store.createInstance(g, { workflowId: 'wf', version: 1, runKey: 'race' }),
      ])
      expect(same[0].instance.id).toBe(same[1].instance.id)
      const page = await store.listInstances(g, 'wf', { limit: 10 })
      expect(page.instances).toHaveLength(2)
      expect(page.next).toBeNull()
    })

    test('one guild never sees or changes another guild`s workflows or instances', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.saveVersion(a, 'secret', version({ status: 'pending' }))
      await store.saveVersion(a, 'secret', version())
      const { instance } = await store.createInstance(a, {
        workflowId: 'secret',
        version: 2,
        runKey: 'k',
      })
      expect(await store.getVersion(b, 'secret')).toBeNull()
      expect(await store.latestActive(b, 'secret')).toBeNull()
      expect(await store.activate(b, 'secret', 1)).toBeNull()
      expect((await store.list(b, { limit: 10 })).workflows).toEqual([])
      expect((await store.versions(b, 'secret', { limit: 10 })).versions).toEqual([])
      expect(await store.getInstance(b, instance.id)).toBeNull()
      expect((await store.listInstances(b, 'secret', { limit: 10 })).instances).toEqual([])
      expect((await store.getVersion(a, 'secret', 1))?.status).toBe('pending')
      await expect(
        store.createInstance(b, { workflowId: 'secret', version: 2, runKey: 'k' })
      ).rejects.toThrow()
    })
  })
}
