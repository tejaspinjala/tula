import { statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { Hono } from 'hono'

const API_PREFIX = '/api'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

/** Strict CSP for the built single-page app: everything from this origin, no inline script. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

/** The absolute path under `dist` for a request path, or null when it tries to leave `dist`. */
function safePath(dist: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return null
  }
  if (decoded.split('/').some((segment) => segment === '..')) {
    return null
  }
  const target = join(dist, decoded)
  return target === dist || target.startsWith(dist + sep) ? target : null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function extension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? '' : path.slice(dot).toLowerCase()
}

function serve(path: string, method: string, immutable: boolean): Response {
  const type = TYPES[extension(path)] ?? 'application/octet-stream'
  const html = type.startsWith('text/html')
  const headers: Record<string, string> = {
    'content-type': type,
    'cache-control': html
      ? 'no-cache'
      : immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  }
  if (html) {
    headers['content-security-policy'] = CSP
    headers['referrer-policy'] = 'no-referrer'
  }
  return new Response(method === 'HEAD' ? null : Bun.file(path), { headers })
}

/**
 * Wraps the API app so one origin serves both: `/api/*` reaches the API with the prefix stripped
 * (un-prefixed routes keep working), files under `dist` are served as static assets, and a browser
 * navigation (`Accept: text/html`) to an unknown path gets `index.html` for the single-page app.
 * Paths that try to leave `dist` are refused with 404.
 */
export function withWebApp(api: Hono, dist: string): Hono {
  const root = dist.replace(/[\\/]+$/, '')
  const outer = new Hono()
  outer.all('*', (c) => {
    const req = c.req.raw
    const url = new URL(req.url)
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      url.pathname = url.pathname.slice(API_PREFIX.length) || '/'
      return api.fetch(new Request(url.toString(), req), c.env)
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const target = safePath(root, url.pathname === '/' ? '/index.html' : url.pathname)
      if (target === null) {
        return c.notFound()
      }
      if (isFile(target)) {
        return serve(target, req.method, url.pathname.startsWith('/assets/'))
      }
      const index = join(root, 'index.html')
      if ((req.headers.get('accept') ?? '').includes('text/html') && isFile(index)) {
        return serve(index, req.method, false)
      }
    }
    return api.fetch(req, c.env)
  })
  return outer
}
