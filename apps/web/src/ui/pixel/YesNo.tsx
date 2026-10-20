/** Props of YesNo. */
export interface YesNoProps {
  question: string
  /** The choice the cursor starts on: NO for destructive actions and Seals. */
  safe: 'yes' | 'no'
  onAnswer: (yes: boolean) => void
}

/** Stub for the red run. */
export function YesNo(_props: YesNoProps) {
  return null
}
