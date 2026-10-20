import type { ReactNode } from 'react'
import { Frame } from './ui/pixel'

/** Props of {@link WorkSection}. */
export interface WorkSectionProps {
  /** Id prefix; the heading gets `<id>-heading`. */
  id: string
  title: string
  children: ReactNode
}

/**
 * The parchment frame every work screen sits in: a landmark section with its Jersey 10 heading.
 * Pages compose it with the pixel kit, so none of them re-styles a container.
 */
export function WorkSection({ id, title, children }: WorkSectionProps) {
  return (
    <section aria-labelledby={`${id}-heading`} className="work">
      <Frame variant="paper">
        <h2 id={`${id}-heading`} className="work-title">
          {title}
        </h2>
        {children}
      </Frame>
    </section>
  )
}
