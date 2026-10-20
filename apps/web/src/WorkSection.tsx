import { createContext, type ReactNode, useContext } from 'react'
import { Frame } from './ui/pixel'

/**
 * True inside a Bag page, whose own wood frame already borders the content: a WorkSection there
 * draws a flat paper surface instead of a second framed one.
 */
export const FlatWorkContext = createContext(false)

/** Props of {@link WorkSection}. */
export interface WorkSectionProps {
  /** Id prefix; the heading gets `<id>-heading`. */
  id: string
  title: string
  children: ReactNode
}

/**
 * The parchment surface every work screen sits on: a landmark section with its Jersey 10 heading.
 * Pages compose it with the pixel kit, so none of them re-styles a container. Inside a Bag page
 * it is flat (see {@link FlatWorkContext}) so the page has one wood border, not two.
 */
export function WorkSection({ id, title, children }: WorkSectionProps) {
  const flat = useContext(FlatWorkContext)
  const content = (
    <>
      <h2 id={`${id}-heading`} className="work-title">
        {title}
      </h2>
      {children}
    </>
  )
  return (
    <section aria-labelledby={`${id}-heading`} className={flat ? 'work work-flat' : 'work'}>
      {flat ? content : <Frame variant="paper">{content}</Frame>}
    </section>
  )
}
