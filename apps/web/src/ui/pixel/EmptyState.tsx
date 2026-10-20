import { Frame } from './Frame'
import { PixelButton } from './PixelButton'
import { Portrait } from './Portrait'

/** Props of EmptyState. */
export interface EmptyStateProps {
  member: string
  line: string
  actionLabel?: string
  onAction?: () => void
}

/**
 * An empty view: a Member and one in-world line ("The Quest Board is empty. Post a Quest?") with a
 * ▶ action. Never "No data".
 */
export function EmptyState({ member, line, actionLabel, onAction }: EmptyStateProps) {
  return (
    <Frame variant="paper" className="px-empty">
      <Portrait name={member} />
      <div className="px-empty-body">
        <p className="px-empty-line">{line}</p>
        {actionLabel && onAction && (
          <PixelButton onClick={onAction}>
            <span className="px-cursor" aria-hidden="true">
              ▶
            </span>
            {actionLabel}
          </PixelButton>
        )}
      </div>
    </Frame>
  )
}
