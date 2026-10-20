import type { ReactNode } from 'react'
import { useReducedMotion } from './ui/pixel'

const STARS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const

/**
 * The title backdrop: the guild town at dusk, the Hall is generated pixel art, the rest stepped CSS
 * blocks (no Phaser, so the signed-out bundle stays small). Stars twinkle and the Hall windows glow in
 * frames; with reduced motion the scene is a still picture. Colours are pixel tokens, so night
 * and day follow the theme.
 */
export function TitleScene({ children }: { children: ReactNode }) {
  const still = useReducedMotion()
  return (
    <div className="title-scene" data-still={still ? 'true' : 'false'}>
      <div className="title-sky" aria-hidden="true">
        <div className="title-band title-band-1" />
        <div className="title-band title-band-2" />
        <div className="title-band title-band-3" />
        {STARS.map((id) => (
          <span key={id} className={`title-star title-star-${id}`} />
        ))}
        <span className="title-moon" />
      </div>
      <div className="title-town" aria-hidden="true">
        <div className="title-hill" />
        <div className="title-hall">
          <span className="title-window title-window-1" />
          <span className="title-window title-window-2" />
        </div>
        <div className="title-cottage title-cottage-1" />
        <div className="title-cottage title-cottage-2" />
        <div className="title-ground" />
      </div>
      <div className="title-content">{children}</div>
    </div>
  )
}
