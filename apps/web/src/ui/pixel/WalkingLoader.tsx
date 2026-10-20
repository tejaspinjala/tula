import { useReducedMotion } from './useReducedMotion'

/** Props of WalkingLoader. */
export interface WalkingLoaderProps {
  label?: string
}

/**
 * The loading state: a small Member walking in place (four frames) beside "Travelling…". Never a
 * spinner or a shimmer. Under reduced motion the Member stands still.
 */
export function WalkingLoader({ label = 'Travelling…' }: WalkingLoaderProps) {
  const reduced = useReducedMotion()
  return (
    <div className="px-loader" role="status">
      <span className="px-walker" aria-hidden="true" data-animated={reduced ? 'false' : 'true'} />
      <span>{label}</span>
    </div>
  )
}
