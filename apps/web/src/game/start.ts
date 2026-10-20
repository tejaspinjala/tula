import Phaser from 'phaser'
import { type HallOptions, HallScene } from './HallScene'
import type { SceneState } from './scene'

/** What the page holds of a running game: draw a state, zoom, pause, tear down. */
export interface GameHandle {
  render: (state: SceneState) => void
  zoomBy: (step: number) => void
  fit: () => void
  /** Moves the Guild Master to a room (its slot), or to the entrance (null). */
  teleport: (slot: number | null) => void
  /** Sleeps the game loop (hidden tab) or wakes it. */
  setPaused: (paused: boolean) => void
  destroy: () => void
}

/**
 * Boots Phaser 4 into `parent`. This module is the only static importer of Phaser, so the page
 * reaches it through a dynamic `import()` and Phaser stays out of the main bundle. Pixel art mode,
 * a resize-aware canvas, WebGL/Canvas only: no DOMElement, no CSS loader, no HTML text, no audio.
 */
export function startGame(parent: HTMLElement, options: HallOptions): GameHandle {
  const scene = new HallScene(options)
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    backgroundColor: '#1b1b26',
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
