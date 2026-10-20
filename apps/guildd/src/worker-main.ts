import { z } from 'zod'
import { runWorker } from './worker'

/** The worker's whole environment: its token, lease handle and where the gateways are. Nothing else. */
const env = z
  .object({
    GUILDHALL_GATEWAY_URL: z.url(),
    GUILDHALL_RUN_TOKEN: z.string().min(1),
    GUILDHALL_LEASE_HANDLE: z.string().min(1),
    GUILDHALL_DONE_CONDITION: z.string().min(1),
  })
  .parse(process.env)

await runWorker({
  gatewayUrl: env.GUILDHALL_GATEWAY_URL,
  runToken: env.GUILDHALL_RUN_TOKEN,
  leaseHandle: env.GUILDHALL_LEASE_HANDLE,
  doneCondition: env.GUILDHALL_DONE_CONDITION,
  fetch: (url, init) => fetch(url, init),
})
