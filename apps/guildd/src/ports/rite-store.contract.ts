import { describe, expect, test } from 'bun:test'
import type { RiteGraph } from '../rites/graph'
import { LEARNING_TO_LINKEDIN } from '../rites/templates'
import type { NewRiteVersion, RiteStore } from './rite-store'

/** A store under test and a way to get real guilds. */
export interface RiteStoreFixture {
  store: RiteStore
  newGuild: () => Promise<string>
}

const graph = (): RiteGraph => structuredClone(LEARNING_TO_LINKEDIN)
const version = (over: Partial<NewRiteVersion> = {}): NewRiteVersion => ({
  name: 'Learning to LinkedIn',
  graph: graph(),
  classification: 'internal',
  status: 'active',
  ...over,
})

/** Saves a draft and publishes it as pending over `basedOn`, as a widening publish does. */
async function pendingOver(
  store: RiteStore,
  g: string,
  riteId: string,
  basedOn: number | null,
  over: Partial<NewRiteVersion> = {}
) {
  const saved = await store.saveVersion(
    g,
    riteId,
    version({ status: 'draft', classification: 'widening', ...over })
  )
  await store.publishDraft(g, riteId, {
    version: saved.version,
    basedOn,
    classifiedAgainst: basedOn,
    outcome: 'pending',
  })
  return saved.version
}

/** The RiteStore contract, run against every adapter. `make` returns a fresh store. */
export function riteStoreContract(name: string, make: () => Promise<RiteStoreFixture>) {
  describe(`RiteStore contract: ${name}`, () => {
    test('a save appends gap-free versions and keeps every graph as written', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const one = await store.saveVersion(g, 'wf', version())
      const edited = graph()
      edited.nodes = edited.nodes.map((n) => (n.id === 'start' ? { ...n, name: 'Go' } : n))
      const two = await store.saveVersion(g, 'wf', version({ graph: edited }))
      expect([one.version, two.version]).toEqual([1, 2])
      expect(one).toMatchObject({
        riteId: 'wf',
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
      await pendingOver(store, g, 'wf', 1)
      expect((await store.latestActive(g, 'wf'))?.version).toBe(1)
      expect((await store.getVersion(g, 'wf'))?.version).toBe(2)
      const activated = await store.activate(g, 'wf', 2)
      expect(activated).toMatchObject({
        ok: true,
        version: { version: 2, status: 'active', classification: 'widening' },
      })
      expect(await store.activate(g, 'wf', 2)).toMatchObject({
        ok: true,
        version: { status: 'active' },
      })
      expect((await store.latestActive(g, 'wf'))?.version).toBe(2)
      expect(await store.activate(g, 'wf', 9)).toEqual({ ok: false, error: 'not_found' })
    })

    test('an archived Rite refuses activation and the pending version stays pending', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await pendingOver(store, g, 'wf', 1)
      await store.archive(g, 'wf')
      expect(await store.activate(g, 'wf', 2)).toEqual({ ok: false, error: 'rite_archived' })
      expect((await store.getVersion(g, 'wf', 2))?.status).toBe('pending')
      expect((await store.latestActive(g, 'wf'))?.version).toBe(1)
    })

    test('rites list in id order, paged, with their latest and active versions', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'b-flow', version({ name: 'B' }))
      await store.saveVersion(g, 'a-flow', version({ name: 'A' }))
      await pendingOver(store, g, 'a-flow', 1, { name: 'A2' })
      const first = await store.list(g, { limit: 1 })
      expect(first.rites).toMatchObject([
        { id: 'a-flow', name: 'A2', latestVersion: 2, activeVersion: 1 },
      ])
      expect(first.next).toBe('a-flow')
      const second = await store.list(g, { after: first.next ?? '', limit: 1 })
      expect(second.rites.map((w) => w.id)).toEqual(['b-flow'])
      expect(second.next).toBeNull()
    })

    test('archiving hides a Rite from the default list and unarchiving brings it back superseded', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'a-flow', version({ name: 'A' }))
      await store.saveVersion(g, 'b-flow', version({ name: 'B' }))
      expect(await store.archivedAt(g, 'a-flow')).toBeNull()
      expect(await store.archive(g, 'a-flow')).toMatchObject({ ok: true, changed: true })
      expect(await store.archivedAt(g, 'a-flow')).not.toBeNull()
      expect((await store.list(g, { limit: 10 })).rites.map((r) => r.id)).toEqual(['b-flow'])
      const only = await store.list(g, { limit: 10, archived: true })
      expect(only.rites).toMatchObject([{ id: 'a-flow' }])
      expect(only.rites[0]?.archivedAt).not.toBeNull()
      // Archiving again changes nothing.
      expect(await store.archive(g, 'a-flow')).toMatchObject({ ok: true, changed: false })
      // The version stays active while archived (a run in flight is not touched).
      expect((await store.latestActive(g, 'a-flow'))?.version).toBe(1)
      expect(await store.unarchive(g, 'a-flow')).toEqual({ ok: true, changed: true, superseded: 1 })
      expect(await store.archivedAt(g, 'a-flow')).toBeNull()
      expect(await store.latestActive(g, 'a-flow')).toBeNull()
      expect((await store.getVersion(g, 'a-flow', 1))?.status).toBe('superseded')
      expect((await store.list(g, { limit: 10 })).rites.map((r) => r.id)).toEqual([
        'a-flow',
        'b-flow',
      ])
      expect(await store.unarchive(g, 'a-flow')).toEqual({
        ok: true,
        changed: false,
        superseded: null,
      })
    })

    test('the archived list stays paginated and a missing Rite cannot be archived', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const id of ['a', 'b', 'c']) {
        await store.saveVersion(g, id, version())
        await store.archive(g, id)
      }
      const first = await store.list(g, { limit: 2, archived: true })
      expect(first.rites.map((r) => r.id)).toEqual(['a', 'b'])
      expect(first.next).toBe('b')
      const rest = await store.list(g, { after: 'b', limit: 2, archived: true })
      expect(rest.rites.map((r) => r.id)).toEqual(['c'])
      expect(await store.archive(g, 'nope')).toEqual({ ok: false, error: 'not_found' })
      expect(await store.unarchive(g, 'nope')).toEqual({ ok: false, error: 'not_found' })
    })

    test('an archived Rite is not re-seeded and another guild is unaffected', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      await store.seedVersion(g, 'tpl', version())
      await store.seedVersion(other, 'tpl', version())
      await store.archive(g, 'tpl')
      expect(await store.seedVersion(g, 'tpl', version())).toBeNull()
      expect((await store.list(g, { limit: 10 })).rites).toEqual([])
      expect(await store.archivedAt(other, 'tpl')).toBeNull()
      expect((await store.list(other, { limit: 10 })).rites).toHaveLength(1)
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
      const first = await store.createInstance(g, { riteId: 'wf', version: 1, runKey: 'k' })
      const again = await store.createInstance(g, { riteId: 'wf', version: 1, runKey: 'k' })
      expect(first.created).toBe(true)
      expect(again).toEqual({ instance: first.instance, created: false })
      expect(first.instance).toMatchObject({ riteId: 'wf', version: 1, runKey: 'k' })
      expect(await store.getInstance(g, first.instance.id)).toEqual(first.instance)
      expect(await store.getInstance(g, crypto.randomUUID())).toBeNull()
      const same = await Promise.all([
        store.createInstance(g, { riteId: 'wf', version: 1, runKey: 'race' }),
        store.createInstance(g, { riteId: 'wf', version: 1, runKey: 'race' }),
      ])
      expect(same[0].instance.id).toBe(same[1].instance.id)
      const page = await store.listInstances(g, 'wf', { limit: 10 })
      expect(page.instances).toHaveLength(2)
      expect(page.next).toBeNull()
    })

    test('a draft never counts as active; publishing an internal draft supersedes the old active', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      expect((await store.latestActive(g, 'wf'))?.version).toBe(1)
      expect((await store.list(g, { limit: 10 })).rites[0]).toMatchObject({
        latestVersion: 2,
        activeVersion: 1,
      })
      const published = await store.publishDraft(g, 'wf', {
        version: 2,
        basedOn: 1,
        classifiedAgainst: 1,
        outcome: 'active',
      })
      expect(published).toMatchObject({ ok: true, version: { version: 2, status: 'active' } })
      expect((await store.getVersion(g, 'wf', 1))?.status).toBe('superseded')
      expect((await store.latestActive(g, 'wf'))?.version).toBe(2)
    })

    test('a widening publish leaves the old active until the version is confirmed', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await store.saveVersion(g, 'wf', version({ status: 'draft', classification: 'widening' }))
      const published = await store.publishDraft(g, 'wf', {
        version: 2,
        basedOn: 1,
        classifiedAgainst: 1,
        outcome: 'pending',
      })
      expect(published).toMatchObject({ ok: true, version: { version: 2, status: 'pending' } })
      expect((await store.latestActive(g, 'wf'))?.version).toBe(1)
      await store.activate(g, 'wf', 2)
      expect((await store.latestActive(g, 'wf'))?.version).toBe(2)
      expect((await store.getVersion(g, 'wf', 1))?.status).toBe('superseded')
    })

    test('a publish based on a moved active version is stale and changes nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      await store.publishDraft(g, 'wf', {
        version: 2,
        basedOn: 1,
        classifiedAgainst: 1,
        outcome: 'active',
      })
      expect(
        await store.publishDraft(g, 'wf', {
          version: 3,
          basedOn: 1,
          classifiedAgainst: 1,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'stale' })
      expect((await store.getVersion(g, 'wf', 3))?.status).toBe('draft')
      expect((await store.latestActive(g, 'wf'))?.version).toBe(2)
      expect(
        await store.publishDraft(g, 'wf', {
          version: 3,
          basedOn: 2,
          classifiedAgainst: 2,
          outcome: 'active',
        })
      ).toMatchObject({ ok: true })
    })

    test('a publish whose classification baseline is no longer the active version is stale', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      expect(
        await store.publishDraft(g, 'wf', {
          version: 2,
          basedOn: 1,
          classifiedAgainst: null,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'stale' })
      expect((await store.getVersion(g, 'wf', 2))?.status).toBe('draft')
    })

    test('confirming a pending version is stale once the active version moved, and changes nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      const pending = await pendingOver(store, g, 'wf', 1)
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      await store.publishDraft(g, 'wf', {
        version: 3,
        basedOn: 1,
        classifiedAgainst: 1,
        outcome: 'active',
      })
      expect(await store.activate(g, 'wf', pending)).toEqual({ ok: false, error: 'stale' })
      expect((await store.latestActive(g, 'wf'))?.version).toBe(3)
      expect((await store.getVersion(g, 'wf', pending))?.status).toBe('pending')
    })

    test('only a draft can be published', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version())
      expect(
        await store.publishDraft(g, 'wf', {
          version: 1,
          basedOn: null,
          classifiedAgainst: null,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'not_draft' })
      expect(
        await store.publishDraft(g, 'wf', {
          version: 9,
          basedOn: 1,
          classifiedAgainst: 1,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'not_found' })
    })

    test('a first publish is based on no active version', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.saveVersion(g, 'wf', version({ status: 'draft' }))
      expect(
        await store.publishDraft(g, 'wf', {
          version: 1,
          basedOn: 1,
          classifiedAgainst: 1,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'stale' })
      expect(
        await store.publishDraft(g, 'wf', {
          version: 1,
          basedOn: null,
          classifiedAgainst: null,
          outcome: 'active',
        })
      ).toMatchObject({ ok: true })
    })

    test('one guild cannot publish another guild`s draft', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.saveVersion(a, 'secret', version({ status: 'draft' }))
      expect(
        await store.publishDraft(b, 'secret', {
          version: 1,
          basedOn: null,
          classifiedAgainst: null,
          outcome: 'active',
        })
      ).toEqual({ ok: false, error: 'not_found' })
      expect((await store.getVersion(a, 'secret', 1))?.status).toBe('draft')
    })

    test('one guild never sees or changes another guild`s rites or instances', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await pendingOver(store, a, 'secret', null)
      await store.activate(a, 'secret', 1)
      await store.saveVersion(a, 'secret', version())
      const { instance } = await store.createInstance(a, {
        riteId: 'secret',
        version: 2,
        runKey: 'k',
      })
      expect(await store.getVersion(b, 'secret')).toBeNull()
      expect(await store.latestActive(b, 'secret')).toBeNull()
      expect(await store.activate(b, 'secret', 1)).toEqual({ ok: false, error: 'not_found' })
      expect((await store.list(b, { limit: 10 })).rites).toEqual([])
      expect((await store.versions(b, 'secret', { limit: 10 })).versions).toEqual([])
      expect(await store.getInstance(b, instance.id)).toBeNull()
      expect((await store.listInstances(b, 'secret', { limit: 10 })).instances).toEqual([])
      expect((await store.getVersion(a, 'secret', 1))?.status).toBe('active')
      await expect(
        store.createInstance(b, { riteId: 'secret', version: 2, runKey: 'k' })
      ).rejects.toThrow()
    })
  })
}
