/** Props of EmptyState. */
export interface EmptyStateProps {
  member: string
  line: string
  actionLabel?: string
  onAction?: () => void
}

/** Stub for the red run. */
export function EmptyState(_props: EmptyStateProps) {
  return null
}
