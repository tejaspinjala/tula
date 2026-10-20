/**
 * Port for fetching one web page as plain text (ADR-0010). guildd, never the sandbox, calls it,
 * so the egress allowlist stays closed. Nothing fetched is executed: the result is text only,
 * returned to a Member as untrusted data.
 */
export interface PageFetcher {
  /**
   * The page's readable text (markup removed, any length; the caller caps it). Throws when the
   * page cannot be fetched or the URL is not allowed; the caller treats that as "no extract".
   */
  fetch(url: string, request: { signal: AbortSignal }): Promise<string>
}

/**
 * A deterministic refusal: the URL is not allowed (not https, a private host), or the page answered
 * 4xx or is not text. Retrying cannot change it, so callers do not retry; its `code` is a short
 * closed reason that is safe to show a Member.
 */
export class PageRefused extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
