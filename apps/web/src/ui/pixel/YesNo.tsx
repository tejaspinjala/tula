import { useId } from 'react'
import { CursorMenu } from './CursorMenu'

/** Props of YesNo. */
export interface YesNoProps {
  question: string
  /** The choice the cursor starts on: NO for destructive actions and Seals. */
  safe: 'yes' | 'no'
  onAnswer: (yes: boolean) => void
  /** Lists the safe choice first (No, Yes); the default order is Yes, No. */
  safeFirst?: boolean
}

const YES = { id: 'yes', label: 'Yes' } as const
const NO = { id: 'no', label: 'No' } as const

/**
 * A Yes/No prompt stacked on the dialogue box. The question should name the cost
 * ("Spend 40 from the Treasury?"). The cursor starts on the safe choice; Y and N answer directly
 * and Esc declines.
 */
export function YesNo({ question, safe, onAnswer, safeFirst = false }: YesNoProps) {
  const id = useId()
  const items = safeFirst && safe === 'no' ? [NO, YES] : [YES, NO]
  const initial = items.findIndex((item) => item.id === safe)

  function onKey(key: string): boolean {
    const lower = key.toLowerCase()
    if (lower === 'y' || lower === 'n') {
      onAnswer(lower === 'y')
      return true
    }
    return false
  }

  return (
    <section className="px-yesno" aria-labelledby={id}>
      <p id={id} className="px-yesno-question">
        {question}
      </p>
      <CursorMenu
        label={question}
        items={items}
        initial={initial}
        autoFocus
        onSelect={(choice) => onAnswer(choice === 'yes')}
        onBack={() => onAnswer(false)}
        onKey={onKey}
      />
    </section>
  )
}
