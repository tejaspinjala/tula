import { z } from 'zod'

const transport = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])
const attachment = z.enum(['cross-platform', 'platform'])
const b64 = z.string().max(20_000)

/** Wire shape of a browser's registration response (WebAuthn `RegistrationResponseJSON`). */
export const registrationResponse = z.object({
  id: b64,
  rawId: b64,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment.exactOptional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({
    clientDataJSON: b64,
    attestationObject: b64,
    authenticatorData: b64.exactOptional(),
    transports: z.array(transport).exactOptional(),
    publicKeyAlgorithm: z.number().exactOptional(),
    publicKey: b64.exactOptional(),
  }),
})

/** Wire shape of a browser's sign-in response (WebAuthn `AuthenticationResponseJSON`). */
export const authenticationResponse = z.object({
  id: b64,
  rawId: b64,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment.exactOptional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({
    clientDataJSON: b64,
    authenticatorData: b64,
    signature: b64,
    userHandle: b64.exactOptional(),
  }),
})

/** Body of a register-finish call. */
export const registerFinishBody = z.object({
  challengeId: z.string().max(100),
  response: registrationResponse,
})

/** Body of a sign-in or re-authentication finish call. */
export const assertFinishBody = z.object({
  challengeId: z.string().max(100),
  response: authenticationResponse,
})
