import { describe, expect, test } from 'bun:test'
import { elderPoses, elderTiles } from './council'

const table = { x: 14, y: 8, w: 2, h: 1 }

describe('elderPoses', () => {
  test('three elders sit around the table in recess, all at rest', () => {
    const elders = elderPoses(table, 'idle')
    expect(elders.map((e) => e.frame)).toEqual(['elder-rest-0', 'elder-rest-1', 'elder-rest-2'])
  })

  test('in session one elder speaks and the others lean in to listen', () => {
    const frames = elderPoses(table, 'conferring').map((e) => e.frame)
    expect(frames).toEqual(['elder-speak-0', 'elder-lean-1', 'elder-lean-2'])
  })

  test('halted, every elder rises with a hand up', () => {
    const frames = elderPoses(table, 'halted').map((e) => e.frame)
    expect(frames).toEqual(['elder-halt-0', 'elder-halt-1', 'elder-halt-2'])
  })

  test('the seats do not change with the state and sit around the table', () => {
    const seats = elderPoses(table, 'idle').map((e) => e.tile)
    expect(seats).toEqual([
      { x: 14, y: 7 },
      { x: 15, y: 7 },
      { x: 13, y: 8 },
    ])
    expect(elderPoses(table, 'halted').map((e) => e.tile)).toEqual(seats)
    expect(elderTiles(table)).toEqual(seats)
  })
})
