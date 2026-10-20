import { useLayoutEffect, useRef } from 'react'

/** Props of Meter. */
export interface MeterProps {
  label: string
  value: number
  max: number
}

/** The fill level: grass above half, warn from 20 to 50 percent, danger below 20 percent. */
export function meterLevel(ratio: number): 'ok' | 'warn' | 'danger' {
  if (ratio > 0.5) {
    return 'ok'
  }
  return ratio >= 0.2 ? 'warn' : 'danger'
}

/**
 * An HP-style meter for caps, Treasury remaining, rate limits and context use. It always shows
 * the number (`37/52`), drains in steps, and below 20 percent adds hatching so colour is never
 * the only signal. The fill is sized through the CSSOM, which the CSP allows.
 */
export function Meter({ label, value, max }: MeterProps) {
  const now = Math.min(Math.max(value, 0), max)
  const ratio = max > 0 ? now / max : 0
  const fill = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    fill.current?.style.setProperty('--fill', String(Math.round(ratio * 100)))
  }, [ratio])

  return (
    <div className="px-meter" data-level={meterLevel(ratio)}>
      <meter
        className="sr-only"
        aria-label={label}
        aria-valuenow={now}
        aria-valuemin={0}
        aria-valuemax={max}
        value={now}
        min={0}
        max={max}
      />
      <span className="px-meter-plate" aria-hidden="true">
        {label}
      </span>
      <span className="px-meter-track" aria-hidden="true">
        <span className="px-meter-fill" ref={fill} />
      </span>
      <span className="px-meter-number" aria-hidden="true">{`${now}/${max}`}</span>
    </div>
  )
}
