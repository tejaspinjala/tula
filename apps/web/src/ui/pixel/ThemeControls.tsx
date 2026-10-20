import { useState } from 'react'
import {
  browserThemeEnv,
  readableText,
  setReadableText,
  setTheme,
  storedTheme,
  type ThemeChoice,
  type ThemeEnv,
} from './theme'

/** Props of ThemeControls. */
export interface ThemeControlsProps {
  /** The browser environment; defaults to the real page. */
  env?: ThemeEnv | null
}

const CHOICES: readonly { id: ThemeChoice; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'day', label: 'Day' },
  { id: 'night', label: 'Night' },
]

/**
 * The Guild Master's look settings: Auto (follow the system), Day or Night for the Hall, and the
 * "Readable text" switch that swaps the pixel font for the system one in long text.
 */
export function ThemeControls({ env }: ThemeControlsProps) {
  const resolved = env === undefined ? browserThemeEnv() : env
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    resolved ? storedTheme(resolved) : 'auto'
  )
  const [readable, setReadable] = useState(() => (resolved ? readableText(resolved) : false))
  if (!resolved) {
    return null
  }
  return (
    <div className="px-theme">
      <fieldset className="px-theme-choices">
        <legend>Hall lighting</legend>
        {CHOICES.map((c) => (
          <label key={c.id}>
            <input
              type="radio"
              name="px-theme"
              checked={choice === c.id}
              onChange={() => {
                setTheme(resolved, c.id)
                setChoice(c.id)
              }}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={readable}
          onChange={(event) => {
            setReadableText(resolved, event.currentTarget.checked)
            setReadable(event.currentTarget.checked)
          }}
        />
        Readable text
      </label>
    </div>
  )
}
