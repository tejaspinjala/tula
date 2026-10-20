import { type KeyboardEvent, useEffect, useState } from 'react'
import { useReducedMotion } from './useReducedMotion'

/** Props of DialogueBox. */
export interface DialogueBoxProps {
  speaker: string
  lines: readonly string[]
  onDone: () => void
  /** Typewriter speed in characters per second (default 40). */
  cps?: number
}

/**
 * A handheld-RPG dialogue box. The whole line is in the DOM (and announced once through a
 * polite live region) from the start; the typewriter only changes what is visibly revealed.
 * Enter, Space or a click finishes the line, then moves on; Esc skips everything. ▼ bobs while
 * more lines remain. Reduced motion shows each line at once.
 */
export function DialogueBox({ speaker, lines, onDone, cps = 40 }: DialogueBoxProps) {
  const reduced = useReducedMotion()
  const last = Math.max(lines.length - 1, 0)
  const [index, setIndex] = useState(0)
  const [count, setCount] = useState(() => (reduced ? (lines[0] ?? '').length : 0))
  const line = lines[index] ?? ''
  const complete = count >= line.length

  useEffect(() => {
    if (reduced) {
      setCount(line.length)
      return
    }
    if (count >= line.length) {
      return
    }
    const id = setTimeout(() => setCount(count + 1), 1000 / cps)
    return () => clearTimeout(id)
  }, [count, line, reduced, cps])

  function advance() {
    if (!complete) {
      setCount(line.length)
    } else if (index < last) {
      const next = lines[index + 1] ?? ''
      setIndex(index + 1)
      setCount(reduced ? next.length : 0)
    } else {
      onDone()
    }
  }

  function skip() {
    setIndex(last)
    setCount((lines[last] ?? '').length)
    onDone()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      advance()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      skip()
    }
  }

  return (
    <div className="px-dialogue-wrap">
      <p className="sr-only" aria-live="polite">
        {line}
      </p>
      <button
        type="button"
        className="px-dialogue"
        aria-label={`${speaker}: ${line}. Continue`}
        onClick={advance}
        onKeyDown={onKeyDown}
      >
        <span className="px-dialogue-speaker" aria-hidden="true">
          {speaker}
        </span>{' '}
        <span className="px-dialogue-text" aria-hidden="true">
          <span className="px-dialogue-shown">{line.slice(0, count)}</span>
          <span className="px-dialogue-rest">{line.slice(count)}</span>
        </span>
        {complete && index < last && (
          <span className="px-dialogue-more" aria-hidden="true">
            ▼
          </span>
        )}
      </button>
    </div>
  )
}
