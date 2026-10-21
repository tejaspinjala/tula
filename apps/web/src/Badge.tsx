/** A status tone; each one pairs a colour with an icon and words, so colour never carries meaning alone. */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'

const ICONS: Record<Tone, string> = {
  ok: '✓',
  warn: '▲',
  danger: '✕',
  info: '●',
  neutral: '○',
}

/** The Seal states the inbox shows, as a tone. */
export function sealTone(status: string): Tone {
  switch (status) {
    case 'requested':
      return 'warn'
    case 'approved':
    case 'approved by the Council':
    case 'posted':
      return 'ok'
    case 'denied':
    case 'expired':
      return 'danger'
    case 'reserved':
      return 'info'
    default:
      return 'neutral'
  }
}

/** The Quest states the board shows, as a tone. */
export function questTone(state: string): Tone {
  switch (state) {
    case 'done':
      return 'ok'
    case 'awaiting_seal':
      return 'warn'
    case 'dead':
      return 'danger'
    case 'active':
      return 'info'
    default:
      return 'neutral'
  }
}

/** A small status pill: an icon, then the words. */
export function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span aria-hidden="true">{ICONS[tone]}</span>
      {children}
    </span>
  )
}
