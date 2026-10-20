import { expect, test } from 'bun:test'
import { initialTalk, nearestTarget, REACH, sameTarget, type Target, talkReducer } from './interact'

const ana: Target = { kind: 'member', id: 'ana' }
const bo: Target = { kind: 'member', id: 'bo' }
const desk: Target = { kind: 'sealDesk' }

test('coming within reach offers a prompt but opens nothing', () => {
  const next = talkReducer(initialTalk, { type: 'near', target: ana })
  expect(next).toEqual({ near: ana, open: null, form: 'view' })
})

test('interacting opens the target in reach, and does nothing with none', () => {
  expect(talkReducer(initialTalk, { type: 'interact' })).toEqual(initialTalk)
  const near = talkReducer(initialTalk, { type: 'near', target: desk })
  expect(talkReducer(near, { type: 'interact' })).toEqual({
    near: desk,
    open: desk,
    form: 'view',
  })
})

test('assigning shows the form, back returns to the view, close closes everything', () => {
  const open = talkReducer(talkReducer(initialTalk, { type: 'near', target: ana }), {
    type: 'interact',
  })
  const assigning = talkReducer(open, { type: 'assign' })
  expect(assigning.form).toBe('assign')
  expect(talkReducer(assigning, { type: 'back' }).form).toBe('view')
  const closed = talkReducer(assigning, { type: 'close' })
  expect(closed.open).toBeNull()
  expect(closed.form).toBe('view')
  expect(closed.near).toEqual(ana)
})

test('assigning needs an open Member, not the Seal desk or nothing', () => {
  expect(talkReducer(initialTalk, { type: 'assign' })).toEqual(initialTalk)
  const deskOpen = talkReducer(talkReducer(initialTalk, { type: 'near', target: desk }), {
    type: 'interact',
  })
  expect(talkReducer(deskOpen, { type: 'assign' })).toEqual(deskOpen)
})

test('walking away while a dialog is open does not close it or change who it is about', () => {
  const open = talkReducer(talkReducer(initialTalk, { type: 'near', target: ana }), {
    type: 'interact',
  })
  const moved = talkReducer(open, { type: 'near', target: bo })
  expect(moved.open).toEqual(ana)
  expect(moved.near).toEqual(bo)
})

test('the nearest target within reach wins; beyond reach there is none', () => {
  const targets = [
    { target: ana, at: { x: 10, y: 10 } },
    { target: bo, at: { x: 11, y: 10 } },
    { target: desk, at: { x: 30, y: 30 } },
  ]
  expect(nearestTarget({ x: 10.9, y: 10 }, targets, REACH)).toEqual(bo)
  expect(nearestTarget({ x: 10.2, y: 10 }, targets, REACH)).toEqual(ana)
  expect(nearestTarget({ x: 20, y: 20 }, targets, REACH)).toBeNull()
  expect(nearestTarget({ x: 11.5, y: 10 }, [], REACH)).toBeNull()
})

test('targets are the same by what they are, not by object', () => {
  expect(sameTarget({ kind: 'member', id: 'ana' }, ana)).toBe(true)
  expect(sameTarget(ana, bo)).toBe(false)
  expect(sameTarget({ kind: 'sealDesk' }, desk)).toBe(true)
  expect(sameTarget(null, null)).toBe(true)
  expect(sameTarget(null, desk)).toBe(false)
})
