import { z } from 'zod'
import { createEgressProxy } from './egress-proxy'

/** Environment of the egress proxy service; read once at boot, failing loudly when wrong. */
const env = z
  .object({
    /** Comma-separated `host:port` pairs a sandbox may reach: the model gateway and the MCP gateway. */
    EGRESS_ALLOWED_HOSTS: z
      .string()
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== '')
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9.-]+:[0-9]{1,5}$/, 'must be host:port')).min(1)),
    EGRESS_PORT: z.coerce.number().int().min(1).max(65535).default(3128),
  })
  .parse(process.env)

createEgressProxy({ allowedHosts: env.EGRESS_ALLOWED_HOSTS }).listen(
  env.EGRESS_PORT,
  '0.0.0.0',
  () => {
    process.stdout.write(
      `egress-proxy listening on ${env.EGRESS_PORT} for ${env.EGRESS_ALLOWED_HOSTS.join(',')}\n`
    )
  }
)
