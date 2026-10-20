/** One slot of a SlotGrid. */
export interface Slot {
  id: string
  label: string
  count?: number
}

/** Props of SlotGrid. */
export interface SlotGridProps {
  label: string
  slots: readonly Slot[]
  columns: number
  onSelect: (id: string) => void
}

/** Stub for the red run. */
export function SlotGrid(_props: SlotGridProps) {
  return null
}
