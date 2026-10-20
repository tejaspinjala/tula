/** Port for the current time, so engine code never reads the wall clock directly. */
export interface Clock {
  /** Returns the current instant. */
  now(): Date
}
