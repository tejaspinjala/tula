import { expect, test } from 'bun:test'
import { integerZoom, phaseAt, tintFor, walkPose } from './daylight'

test('the hour of day picks day, dusk or night', () => {
  expect(phaseAt(12)).toBe('day')
  expect(phaseAt(8)).toBe('day')
  expect(phaseAt(18)).toBe('dusk')
  expect(phaseAt(19)).toBe('dusk')
  expect(phaseAt(21)).toBe('night')
  expect(phaseAt(3)).toBe('night')
  expect(phaseAt(6)).toBe('dusk')
})

test('day has no tint and no lanterns; dusk warms 12% and night cools 35% with lanterns', () => {
  expect(tintFor('day')).toEqual({ color: 0xffffff, alpha: 0, lanterns: false })
  expect(tintFor('dusk')).toEqual({ color: 0xffb36b, alpha: 0.12, lanterns: false })
  expect(tintFor('night')).toEqual({ color: 0x1d2a55, alpha: 0.35, lanterns: true })
})

test('the camera zooms by whole numbers, at least 1, at most 4', () => {
  expect(integerZoom(390, 600, 640, 400)).toBe(1)
  expect(integerZoom(1280, 800, 640, 400)).toBe(2)
  expect(integerZoom(1280, 800, 288, 160)).toBe(4)
  expect(integerZoom(3000, 3000, 100, 100)).toBe(4)
  expect(integerZoom(10, 10, 640, 400)).toBe(1)
})

test('a walk is four poses, looping, and standing is the still pose', () => {
  expect(walkPose(0, false)).toEqual({ frame: 0, lift: 0, lean: 0 })
  const frames = [0, 1, 2, 3].map((n) => walkPose(n * 150, true).frame)
  expect(frames).toEqual([0, 1, 2, 3])
  expect(walkPose(600, true).frame).toBe(0)
  const lifts = [0, 1, 2, 3].map((n) => walkPose(n * 150, true).lift)
  expect(lifts).toEqual([0, -1, 0, -1])
  const leans = [0, 1, 2, 3].map((n) => walkPose(n * 150, true).lean)
  expect(leans).toEqual([0, 1, 0, -1])
})
