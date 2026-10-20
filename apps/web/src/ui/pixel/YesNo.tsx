import { useId } from 'react'
import { CursorMenu } from './CursorMenu'

/** Props of YesNo. */
export interface YesNoProps {
  question: string
  /** The choice the cursor starts on: NO for destructive actions and Seals. */
  safe: 'yes' | 'no'
  onAnswer: (yes: boolean) => void
}

const ITEMS = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
] as const

/**
 * A Yes/No prompt stacked on the dialogue box. The question should name the cost
 * ("Spend 40 from the Treasury?"). The cursor starts on the safe choice; Y and N answer directly
 * and Esc declines.
 */
export function YesNo({ question, safe, onAnswer }: YesNoProps) {
  const id = useId()

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
        items={ITEMS}
        initial={safe === 'yes' ? 0 : 1}
        autoFocus
        onSelect={(choice) => onAnswer(choice === 'yes')}
        onBack={() => onAnswer(false)}
        onKey={onKey}
      />
    </section>
  )
}
