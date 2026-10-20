/** Props of Portrait. */
export interface PortraitProps {
  name: string
  mood?: 'neutral' | 'happy' | 'worried'
  state?: 'ok' | 'paused' | 'error'
}

/** Stub for the red run. */
export function Portrait(_props: PortraitProps) {
  return null
}
