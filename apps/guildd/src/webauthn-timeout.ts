/**
 * The WebAuthn ceremony `timeout` (ms) guildd puts in every registration and authentication
 * options set. The web client's own ceremony bound must stay strictly below it.
 */
export const WEBAUTHN_CEREMONY_TIMEOUT_MS = 45_000
