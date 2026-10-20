import { z } from 'zod'

/** The deterministic checks a Verdict runs, in order. No model decides any of them. */
export const CHECK_NAMES = [
  'length',
  'banned_terms',
  'required_terms',
  'links',
  'private_data',
] as const
/** One check name. */
export type CheckName = (typeof CHECK_NAMES)[number]

/** One check's result. `detail` names what failed by rule, never by echoing the matched content. */
export const finding = z.object({
  check: z.enum(CHECK_NAMES),
  passed: z.boolean(),
  detail: z.string().max(500),
})
/** One check's result. */
export type Finding = z.infer<typeof finding>

/** The content policy the checks apply: limits and terms. */
export interface ContentPolicy {
  maxLength: number
  bannedTerms: string[]
  requiredTerms: string[]
}

/** The policy used until guild config carries its own banned and required terms. */
export const DEFAULT_POLICY: ContentPolicy = {
  maxLength: 3000,
  bannedTerms: [],
  requiredTerms: [],
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+|\bjavascript:[^\s]*/gi
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

const PRIVATE_MARKERS: Array<[label: string, pattern: RegExp]> = [
  ['email address', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  ['card number', /\b(?:\d[ -]?){13,16}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api token', /\b(?:sk|pk|ghp|xox[bap])[-_][a-z0-9_-]{16,}/i],
  ['secret label', /\b(?:password|passwd|secret|api[ _-]?key)\s*[:=]/i],
  ['national id', /\b\d{3}-\d{2}-\d{4}\b/],
]

function lengthCheck(content: string, policy: ContentPolicy): Finding {
  const size = content.trim().length
  const passed = size > 0 && content.length <= policy.maxLength
  return {
    check: 'length',
    passed,
    detail: passed ? 'within the length limit' : `must be 1 to ${policy.maxLength} characters`,
  }
}

function bannedCheck(content: string, policy: ContentPolicy): Finding {
  const lower = content.toLowerCase()
  const hits = policy.bannedTerms.filter((t) => lower.includes(t.toLowerCase())).length
  return {
    check: 'banned_terms',
    passed: hits === 0,
    detail: hits === 0 ? 'no banned terms' : `${hits} banned term(s) present`,
  }
}

function requiredCheck(content: string, policy: ContentPolicy): Finding {
  const lower = content.toLowerCase()
  const missing = policy.requiredTerms.filter((t) => !lower.includes(t.toLowerCase())).length
  return {
    check: 'required_terms',
    passed: missing === 0,
    detail: missing === 0 ? 'all required terms present' : `${missing} required term(s) missing`,
  }
}

function unsafeLink(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  const host = url.hostname.toLowerCase()
  return (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    IPV4.test(host) ||
    host.includes(':') ||
    !host.includes('.')
  )
}

function linksCheck(content: string): Finding {
  const bad = (content.match(URL_PATTERN) ?? []).filter(unsafeLink).length
  return {
    check: 'links',
    passed: bad === 0,
    detail: bad === 0 ? 'every link is a public https URL' : `${bad} unsafe link(s)`,
  }
}

function privateCheck(content: string): Finding {
  const labels = PRIVATE_MARKERS.filter(([, p]) => p.test(content)).map(([label]) => label)
  return {
    check: 'private_data',
    passed: labels.length === 0,
    detail:
      labels.length === 0 ? 'no private-data markers' : `private-data marker: ${labels.join(', ')}`,
  }
}

/** Runs every deterministic check over `content`; pure, so the same content always gives the same findings. */
export function runChecks(content: string, policy: ContentPolicy): Finding[] {
  return [
    lengthCheck(content, policy),
    bannedCheck(content, policy),
    requiredCheck(content, policy),
    linksCheck(content),
    privateCheck(content),
  ]
}

/** Whether every finding passed; a Verdict passes only then. */
export function allPassed(findings: Finding[]): boolean {
  return findings.every((f) => f.passed)
}
