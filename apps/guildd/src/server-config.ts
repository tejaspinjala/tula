/** The listen options guildd hands to Bun: port, bind address (loopback by default) and body limit. */
export function listenOptions(env: { PORT: number; HOST: string }, maxBody: number) {
  return { port: env.PORT, hostname: env.HOST, maxRequestBodySize: maxBody }
}
