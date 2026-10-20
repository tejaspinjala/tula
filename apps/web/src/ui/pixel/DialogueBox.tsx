/** Props of DialogueBox. */
export interface DialogueBoxProps {
  speaker: string
  lines: readonly string[]
  onDone: () => void
  /** Typewriter speed in characters per second (default 40). */
  cps?: number
}

/** Stub for the red run. */
export function DialogueBox(_props: DialogueBoxProps) {
  return null
}
