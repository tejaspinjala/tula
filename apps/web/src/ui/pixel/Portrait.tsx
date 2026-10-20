/** Props of Portrait. */
export interface PortraitProps {
  name: string
  mood?: 'neutral' | 'happy' | 'worried'
  state?: 'ok' | 'paused' | 'error'
}

const HUES = 6

/** A stable look (0 to 5) for a name, so a Member keeps the same colours everywhere. */
function hueFor(name: string): number {
  let sum = 0
  for (const char of name) {
    sum = (sum * 31 + char.charCodeAt(0)) % 997
  }
  return sum % HUES
}

const STATE_WORD = { paused: 'Paused', error: 'Trouble' } as const

/**
 * A framed bust of a Member at a whole-number scale. The look comes from the name, the
 * expression from `mood`. A paused or errored Member is greyed and shows an icon and a word.
 */
export function Portrait({ name, mood = 'neutral', state = 'ok' }: PortraitProps) {
  const word = state === 'ok' ? null : STATE_WORD[state]
  return (
    <figure className="px-portrait-wrap">
      <div
        className="px-portrait"
        role="img"
        aria-label={word ? `${name}, ${word.toLowerCase()}` : name}
        data-hue={hueFor(name)}
        data-mood={mood}
        data-state={state}
      >
        <span className="px-portrait-head" aria-hidden="true" />
        <span className="px-portrait-body" aria-hidden="true" />
      </div>
      {word && (
        <figcaption className="px-portrait-state">
          <span className="px-portrait-icon" aria-hidden="true" />
          {word}
        </figcaption>
      )}
    </figure>
  )
}
