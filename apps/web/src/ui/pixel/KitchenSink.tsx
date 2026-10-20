/** Whether `pathname` is the dev-only kitchen sink; never in a production build. */
export function isKitchenSinkPath(_pathname: string, _dev: boolean): boolean {
  return false
}

/** Stub for the red run. */
export function KitchenSink() {
  return null
}
