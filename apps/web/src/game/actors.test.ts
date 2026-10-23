import { describe, expect, test } from 'bun:test'
import { apprenticeSeats, memberSpot } from './actors'
import { roomFor } from './room'

const hall = { id: 'h1', name: 'Research', kind: 'work' as const, locked: false, index: 0 }
const crew = [{ id: 'cap', captain: true }, { id: 'a' }, { id: 'b' }]

describe('Members at their stations', () => {
  const room = roomFor(hall, crew, 'library')

  test('a Member stands at their own station in their own Hall room', () => {
    for (const m of crew) {
      const station = room.stations.find((s) => s.memberId === m.id)
      expect(station).toBeDefined()
      expect(memberSpot(room, 'hall:h1', m.id)).toEqual({
        map: 'hall:h1',
        x: station?.tile.x ?? -1,
        y: station?.tile.y ?? -1,
      })
    }
  })

  test('a Member without a station stands at the room spawn', () => {
    expect(memberSpot(room, 'hall:h1', 'stranger')).toEqual({
      map: 'hall:h1',
      x: room.spawn.x,
      y: room.spawn.y,
    })
  })

  test('apprentices stand on free floor, off every station, the mailbox and the entry', () => {
    const seats = apprenticeSeats(room, 5)
    expect(seats).toHaveLength(5)
    const taken = new Set([
      ...room.stations.map((s) => `${s.tile.x},${s.tile.y}`),
      `${room.spawn.x},${room.spawn.y}`,
    ])
    for (const seat of seats) {
      expect(room.walkable(seat.x, seat.y)).toBe(true)
      expect(taken.has(`${seat.x},${seat.y}`)).toBe(false)
    }
    expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(5)
  })
})
