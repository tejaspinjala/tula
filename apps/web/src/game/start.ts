import Phaser from 'phaser'
import { z } from 'zod'
import { type Phase, phaseAt } from './daylight'
import { type HallOptions, HallScene } from './HallScene'
import type { LookChoice } from './look'
import type { SceneState } from './scene'
import type { PlaceName } from './world'

/** What the page holds of a running game: draw a state, zoom, pause, tear down. */
export interface GameHandle {
  render: (state: SceneState) => void
  zoomBy: (step: number) => void
  fit: () => void
  /** Moves the Guild Master to a room (its slot), or to the entrance (null). */
  teleport: (slot: number | null) => void
  /** Walks the Guild Master to a named place of the town (any map). */
  goTo: (place: PlaceName) => void
  /** Lights the world for a time of day (null follows the clock). */
  setPhase: (phase: Phase | null) => void
  /** Dresses the Guild Master's character in a look, live. */
  setLook: (look: LookChoice) => void
  /** Sleeps the game loop (hidden tab) or wakes it. */
  setPaused: (paused: boolean) => void
  destroy: () => void
}

/** The phase for the clock right now. */
const phaseNow = () => phaseAt(new Date().getHours())

/**
 * Boots Phaser 4 into `parent`. This module is the only static importer of Phaser, so the page
 * reaches it through a dynamic `import()` and Phaser stays out of the main bundle. Pixel art mode,
 * a resize-aware canvas, WebGL/Canvas only: no DOMElement, no CSS loader, no HTML text, no audio.
 */
export function startGame(parent: HTMLElement, options: HallOptions): GameHandle {
  const scene = new HallScene(options)
  // `?time=dusk` (or day, night) lights the world for that time of day instead of the clock.
  const forced = z
    .enum(['day', 'dusk', 'night'])
    .safeParse(new URLSearchParams(window.location.search).get('time'))
  if (forced.success) {
    scene.setPhase(forced.data)
  }
  // `?slot=N` (0-143, ten minutes each) pins the routine slot, for run-checks.
  const slot = z.coerce
    .number()
    .int()
    .min(0)
    .max(143)
    .safeParse(new URLSearchParams(window.location.search).get('slot'))
  if (slot.success) {
    scene.setSlot(slot.data)
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    render: { roundPixels: true },
    transparent: true,
    banner: false,
    audio: { noAudio: true },
    disableContextMenu: true,
    // Images load as <img> (img-src 'self'), never as blob: URLs.
    loader: { imageLoadType: 'HTMLImageElement' },
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: Math.max(1, parent.clientWidth),
      height: Math.max(1, parent.clientHeight),
    },
    scene,
  })
  return {
    render: (state) => scene.render(state),
    zoomBy: (step) => scene.zoomBy(step),
    fit: () => scene.fit(),
    teleport: (slot) => scene.teleport(slot),
    goTo: (place) => scene.goTo(place),
    setPhase: (phase) => (phase ? scene.setPhase(phase) : scene.setPhase(phaseNow(), false)),
    setLook: (look) => scene.setPlayerLook(look),
    setPaused: (paused) => {
      if (paused) {
        game.loop.sleep()
      } else {
        game.loop.wake()
      }
    },
    destroy: () => game.destroy(true),
  }
}
