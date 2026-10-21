/** The time of day the world is lit for. */
export type Phase = 'day' | 'dusk' | 'night'

/** The phase for an hour of the day (0-23): dusk at 6 and from 18 to 20, night from 21 to 5. */
export function phaseAt(hour: number): Phase {
  if (hour >= 7 && hour <= 17) {
    return 'day'
  }
  if (hour === 6 || (hour >= 18 && hour <= 20)) {
    return 'dusk'
  }
  return 'night'
}

/** How the world is tinted: a multiply colour at an opacity, and whether lanterns are lit. */
export interface Tint {
  color: number
  alpha: number
  lanterns: boolean
}

/** Dusk multiplies #ffb36b at 12%, night #1d2a55 at 35% with lanterns lit; day is untinted. */
export function tintFor(phase: Phase): Tint {
  switch (phase) {
    case 'day':
      return { color: 0xffffff, alpha: 0, lanterns: false }
    case 'dusk':
      return { color: 0xffb36b, alpha: 0.12, lanterns: false }
    case 'night':
      return { color: 0x1d2a55, alpha: 0.35, lanterns: true }
  }
}

/** The camera zoom that fits a world in a frame by whole numbers: at least 1, at most 4. */
export function integerZoom(
  frameW: number,
  frameH: number,
  worldW: number,
  worldH: number
): number {
  const fill = Math.floor(Math.min(frameW / worldW, frameH / worldH))
  return Math.min(4, Math.max(1, fill))
}

/** The whole zoom a map opens at: the smallest that fills the frame on both axes (1 to 4); the camera follows the Guild Master. */
export function openZoomWhole(
  frameW: number,
  frameH: number,
  worldW: number,
  worldH: number
): number {
  const fill = Math.ceil(Math.max(frameW / worldW, frameH / worldH))
  return Math.min(4, Math.max(1, fill))
}

/** The zoom after a resize: the one a fresh load of that frame opens at. */
export function zoomAfterResize(
  frameW: number,
  frameH: number,
  worldW: number,
  worldH: number
): number {
  return openZoomWhole(frameW, frameH, worldW, worldH)
}

/** One pose of the walk cycle: which of four frames, and the pixel offsets that make it. */
export interface Pose {
  frame: 0 | 1 | 2 | 3
  /** Vertical offset of the body, in px (negative is up). */
  lift: 0 | -1
  /** Horizontal lean of the body, in px. */
  lean: 0 | 1 | -1
}

const POSES: readonly Pose[] = [
  { frame: 0, lift: 0, lean: 0 },
  { frame: 1, lift: -1, lean: 1 },
  { frame: 2, lift: 0, lean: 0 },
  { frame: 3, lift: -1, lean: -1 },
]

/** Milliseconds each of the four poses is held. */
export const POSE_MS = 150

/** The pose of a character `ms` into a walk (still when not walking); the cycle is four poses and loops. */
export function walkPose(ms: number, walking: boolean): Pose {
  const first = POSES[0] as Pose
  if (!walking) {
    return first
  }
  return POSES[Math.floor(ms / POSE_MS) % POSES.length] ?? first
}
