import type { ButtonHTMLAttributes } from 'react'

/** Props of PixelButton. */
export interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Marks a destructive action (Bar the Gates); it gets a warning icon beside its word. */
  danger?: boolean
}

/**
 * A raised pixel button with a hard shadow; pressing it moves it down. Labels are Silkscreen.
 * Disabled buttons stay visible with a checker overlay. A danger button carries an icon and a
 * word, never colour alone.
 */
export function PixelButton({
  danger = false,
  type = 'button',
  className,
  children,
  ...rest
}: PixelButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={className ? `px-btn ${className}` : 'px-btn'}
      data-danger={danger ? 'true' : undefined}
    >
      {danger && <span className="px-btn-icon" aria-hidden="true" />}
      {children}
    </button>
  )
}
