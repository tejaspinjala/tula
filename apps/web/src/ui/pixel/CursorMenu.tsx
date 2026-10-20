/** One row of a CursorMenu. */
export interface CursorMenuItem {
  id: string
  label: string
  disabled?: boolean
}

/** Props of CursorMenu. */
export interface CursorMenuProps {
  label: string
  items: readonly CursorMenuItem[]
  onSelect: (id: string) => void
  onBack?: (() => void) | undefined
}

/** Stub for the red run. */
export function CursorMenu(_props: CursorMenuProps) {
  return null
}
