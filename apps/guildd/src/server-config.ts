/** The listen options guildd hands to Bun: port, bind address and body limit. */
export function listenOptions(env: { PORT: number; HOST?: string | undefined }, maxBody: number) {
  return { port: env.PORT, hostname: '0.0.0.0', maxRequestBodySize: maxBody }
}
