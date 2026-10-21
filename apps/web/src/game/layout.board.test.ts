import { expect, test } from 'bun:test'
import { apprenticeSeats, hallLayout, mailboxIn, questBoardIn } from './layout'
import { findPath } from './walk'

const layout = hallLayout()

test('every room has a walkable Quest Board tile that the work row can walk to', () => {
  for (const room of layout.rooms) {
    const board = questBoardIn(layout, room)
    expect(layout.walkable(board.x, board.y)).toBe(true)
    // Below the room label row, and in the room's far corner from the work row's start.
    expect(board.y).toBeGreaterThan(room.y)
    expect(board.x).toBeGreaterThan(room.x + 1)
    const work = { x: room.x + 1, y: room.y + 2 }
    expect(findPath(layout.walkable, work, board)).not.toBeNull()
  }
})

test('apprentice seats are distinct, walkable, inside the room and not on the Quest Board', () => {
  for (const room of layout.rooms) {
    const board = questBoardIn(layout, room)
    const seats = apprenticeSeats(layout, room, 4)
    expect(seats).toHaveLength(4)
    expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(4)
    for (const seat of seats) {
      expect(layout.walkable(seat.x, seat.y)).toBe(true)
      expect(seat.x >= room.x && seat.x < room.x + room.w).toBe(true)
      expect(seat.y >= room.y && seat.y < room.y + room.h).toBe(true)
      expect(seat).not.toEqual(board)
    }
  }
})

test('every room has a walkable mailbox tile, clear of the Quest Board and reachable', () => {
  for (const room of layout.rooms) {
    const box = mailboxIn(layout, room)
    const board = questBoardIn(layout, room)
    expect(layout.walkable(box.x, box.y)).toBe(true)
    expect(box).not.toEqual(board)
    expect(box.y).toBeGreaterThan(room.y)
    expect(box.x >= room.x && box.x < room.x + room.w).toBe(true)
    expect(findPath(layout.walkable, { x: room.x + 1, y: room.y + 2 }, box)).not.toBeNull()
  }
})
