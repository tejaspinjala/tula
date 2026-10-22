import { expect, test } from 'bun:test'
import { memberSpot } from './actors'
import { type Anim, CHATTER, type PlanInput, planFor } from './behavior'
import { routeBetween } from './route'
import { ACTIVITIES, type Activity, deriveScene, type SceneMember } from './scene'
import { hallRoomOf, mapData, type PlaceName, placeNamed, setHalls } from './world'

const home = { map: 'hall', x: 10, y: 10 } as const
const desk = { map: 'hall', x: 10, y: 8 } as const
const member = (extra: Partial<SceneMember> = {}): SceneMember => ({
  id: 'm2',
  name: 'Bram',
  hallId: 'h',
  rank: 'member',
  status: 'idle',
  questId: null,
  bubble: null,
  claimSeq: null,
  ...extra,
})
const input = (extra: Partial<PlanInput> = {}): PlanInput => ({
  seed: 'guild-1',
  member: member(),
  home,
  desk,
  phase: 'day',
  slot: 30,
  idleIds: ['m2'],
  handIn: false,
  ...extra,
})
const working = (name: Activity, seq = 5) =>
  input({ member: member({ status: 'working', questId: 'q1', activity: { name, seq } }) })
const stand = (name: PlaceName) => {
  const place = placeNamed(name)
  return { map: place.map, x: place.stand.x, y: place.stand.y }
}

const BY_ACTIVITY: [Activity, PlaceName | 'desk', Anim][] = [
  ['reading_brief', 'archive-shelves', 'read'],
  ['reading_archive', 'archive-shelves', 'read'],
  ['writing_archive', 'archive-shelves', 'write'],
  ['writing', 'desk', 'write'],
  ['spawning', 'desk', 'summon'],
  ['waiting', 'seal-desk', 'stand'],
  ['messaging', 'desk', 'talk'],
  ['proposing', 'steward-desk', 'talk'],
  ['thinking', 'desk', 'think'],
]

for (const [activity, place, anim] of BY_ACTIVITY) {
  test(`${activity} puts a working Member at ${place} to ${anim}`, () => {
    const plan = planFor(working(activity))
    const last = plan.stops.at(-1)
    expect(last?.spot).toEqual(place === 'desk' ? desk : stand(place))
    expect(last?.anim).toBe(anim)
    expect(last?.hidden).toBe(false)
  })
}

test('every activity guildd names has a plan', () => {
  const covered = new Set<string>(['researching', ...BY_ACTIVITY.map(([a]) => a)])
  expect([...ACTIVITIES].filter((a) => !covered.has(a))).toEqual([])
})

test('researching walks out to the Wilds, vanishes for a while, and comes back with a scroll', () => {
  const plan = planFor(working('researching'))
  expect(plan.stops.length).toBe(2)
  const [out, back] = plan.stops
  expect(out?.spot).toEqual(stand('wilds'))
  expect(out?.hidden).toBe(true)
  expect(out?.dwellMs).toBeGreaterThan(0)
  expect(back?.spot).toEqual(desk)
  expect(back?.carry).toBe('scroll')
})

test('a Member whose Quest awaits a Seal stands at the Seal desk', () => {
  const plan = planFor(input({ member: member({ awaitingSeal: true }) }))
  expect(plan.stops.at(-1)?.spot).toEqual(stand('seal-desk'))
  expect(plan.stops.at(-1)?.anim).toBe('stand')
})

test('a Member working another Quest is not frozen at the Seal desk', () => {
  const plan = planFor(
    input({
      member: member({
        status: 'working',
        questId: 'q2',
        awaitingSeal: true,
        activity: { name: 'writing', seq: 7 },
      }),
    })
  )
  expect(plan.key).toBe('m2:writing@7')
  expect(plan.stops.at(-1)?.spot).toEqual(desk)
})

test('a finished Quest is handed in at the Quest Board before the routine resumes', () => {
  const plan = planFor(input({ handIn: true, member: member({ doneSeq: 9 }) }))
  expect(plan.stops[0]?.spot).toEqual(stand('quest-board'))
  expect(plan.stops[0]?.anim).toBe('handin')
  expect(plan.stops.length).toBeGreaterThan(1)
})

test('an idle Member sleeps in their seat at night', () => {
  const plan = planFor(input({ phase: 'night' }))
  expect(plan.stops).toHaveLength(1)
  expect(plan.stops[0]?.spot).toEqual(home)
  expect(plan.stops[0]?.anim).toBe('sleep')
})

test('the same seed, Member and time give the same plan, in any order of the idle crowd', () => {
  const crowd = ['m1', 'm2', 'm3', 'm4', 'm5']
  const a = planFor(input({ idleIds: crowd }))
  expect(planFor(input({ idleIds: [...crowd].reverse() }))).toEqual(a)
  expect(planFor(input({ idleIds: crowd }))).toEqual(a)
})

test('the day routine varies with the time and the Member, and only visits real places', () => {
  const crowd = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  const kinds = new Set<string>()
  for (let slot = 0; slot < 144; slot++) {
    for (const id of crowd) {
      const plan = planFor(input({ member: member({ id }), idleIds: crowd, slot }))
      const last = plan.stops.at(-1)
      expect(last).toBeDefined()
      if (last) {
        expect(mapData(last.spot.map).walkable(last.spot.x, last.spot.y)).toBe(true)
        kinds.add(`${last.spot.map}:${last.anim}`)
      }
    }
  }
  expect(kinds.size).toBeGreaterThanOrEqual(3)
  expect(kinds).toContain('plaza:chat')
  expect(kinds).toContain('archive:read')
})

test('two Members who chat meet side by side, and each speaks a line from the fixed table', () => {
  const crowd = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  for (let slot = 0; slot < 144; slot++) {
    const chatting = crowd.flatMap((id) => {
      const stop = planFor(input({ member: member({ id }), idleIds: crowd, slot })).stops.at(-1)
      return stop?.anim === 'chat' ? [{ id, stop }] : []
    })
    expect(chatting.length % 2).toBe(0)
    for (const { stop } of chatting) {
      expect(CHATTER).toContain(stop.line ?? '')
    }
    if (chatting.length >= 2) {
      const [a, b] = chatting
      expect(a?.stop.spot.map).toBe('plaza')
      expect(Math.abs((a?.stop.spot.x ?? 0) - (b?.stop.spot.x ?? 99))).toBeLessThanOrEqual(1)
      expect(a?.stop.line).not.toBe(b?.stop.line)
      return
    }
  }
  throw new Error('nobody ever chatted')
})

test('the plan key changes with a new activity or a new routine slot, not with a repeat', () => {
  expect(planFor(working('writing', 5)).key).toBe(planFor(working('writing', 5)).key)
  expect(planFor(working('writing', 5)).key).not.toBe(planFor(working('writing', 6)).key)
  expect(planFor(input({ slot: 1 })).key).not.toBe(planFor(input({ slot: 2 })).key)
})

test('replaying the log to any seq plans the same as a fresh fold to that seq', () => {
  const roster = {
    steward: { id: 's1', name: 'Steward' },
    halls: [
      {
        id: 'h',
        name: 'Heralds',
        kind: 'work' as const,
        locked: false,
        captain: null,
        members: [{ id: 'm2', name: 'Bram', rank: 'member' }],
      },
    ],
  }
  const quests = [{ id: 'q1', title: 'T', hallId: 'h', ownerId: 'm2' }]
  const at = (seq: number, type: string, payload: unknown) => ({
    seq,
    type,
    payload,
    occurredAt: '2026-10-20T10:00:00Z',
  })
  const act = (seq: number, activity: string) =>
    at(seq, 'member.activity', { questId: 'q1', memberId: 'm2', hallId: 'h', activity })
  const events = [
    at(1, 'quest.claimed', { questId: 'q1', hallId: 'h' }),
    act(2, 'reading_archive'),
    act(3, 'researching'),
    act(4, 'writing'),
    at(5, 'quest.awaiting_seal', { questId: 'q1' }),
    at(6, 'quest.done', { questId: 'q1' }),
  ]
  const planAt = (upTo: number) => {
    const m = deriveScene({ roster, quests, events, upTo }).members.m2
    return m ? planFor(input({ member: m })) : null
  }
  const forward = [1, 2, 3, 4, 5, 6].map(planAt)
  const backward = [6, 5, 4, 3, 2, 1].map(planAt).reverse()
  expect(backward).toEqual(forward)
  expect(new Set(forward.map((p) => p?.key)).size).toBe(6)
})

test('a Seal-waiting Member leaves their Hall room by its doorway and ends at the Great Hall Seal desk', () => {
  setHalls([
    {
      hall: { id: 'a', name: 'a', kind: 'work', locked: false },
      members: [{ id: 'a-m0', captain: true }],
    },
  ])
  const room = hallRoomOf('hall:a')
  if (!room) {
    throw new Error('no room')
  }
  const seat = memberSpot(room, 'hall:a', 'a-m0')
  const plan = planFor(input({ home: seat, desk: seat, member: member({ awaitingSeal: true }) }))
  const target = plan.stops.at(-1)?.spot
  expect(target).toEqual(stand('seal-desk'))
  if (!target) {
    return
  }
  const legs = routeBetween(seat, target)
  expect(legs?.map((l) => l.map)).toEqual(['hall:a', 'hall'])
  expect(legs?.at(-1)?.path.at(-1)).toEqual({ x: target.x, y: target.y })
  setHalls([])
})
