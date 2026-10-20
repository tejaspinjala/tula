import type { Quest } from './ports/quest-queue'

/** The most tokens a Brief may take. */
export const BRIEF_TOKEN_CAP = 2000

/** Skill sections a Quest template points its Member at, by template id. Code, not model output. */
export const SKILL_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  'herald-brief': ['heralds/brief#structure', 'heralds/voice#tone'],
  'herald-announcement': ['heralds/announcement#format', 'heralds/voice#tone'],
}

/** What the compiler needs; everything is passed in, so the Brief is a pure function of it. */
export interface BriefInput {
  quest: Quest
  /** The Member's role (its rank). */
  role: string
  /** The role's frozen, ordered tool list. */
  tools: readonly string[]
  /** Archive notes in the Quest's Hall worth reading, by id and title. */
  notes: ReadonlyArray<{ id: string; title: string }>
}

/** A compiled Brief. */
export interface Brief {
  /** The part that is the same for every Quest of one role and tool list; it comes first, for caching. */
  prefix: string
  text: string
  /** Estimated tokens of `text`. */
  tokens: number
}

/** A rough token count: four characters to a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Compiles the Brief for one run: stable prefix first, then the Quest and its done-condition, then
 * pointers (note ids, skill sections) in a fixed order. Deterministic. Over `cap` tokens, pointers
 * are dropped from the end and counted; a Quest that alone exceeds the cap is refused.
 * @throws Error `brief_too_large`
 */
export function compileBrief(input: BriefInput, cap: number = BRIEF_TOKEN_CAP): Brief {
  const { quest } = input
  const prefix = [
    'You are a Member of the guild, working one Quest.',
    `Role: ${input.role}`,
    `Tools, in order: ${input.tools.join(', ')}`,
    'Pass the lease handle you were given to every tool. File your output as an artifact, then complete the Quest with a Handoff that cites evidence.',
    '',
  ].join('\n')
  const body = [
    `Quest: ${quest.title} (${quest.id})`,
    `Hall: ${quest.hallId}`,
    `Round: ${quest.round + 1} of ${quest.roundLimit}`,
    `Done when: ${quest.doneCondition}`,
  ].join('\n')
  const pointers = [
    ...[...input.notes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => `note ${n.id}: ${n.title}`),
    ...(SKILL_SECTIONS[quest.templateId] ?? []).map((s) => `skill ${s}`),
  ]
  const render = (kept: number): string => {
    const lines = pointers.slice(0, kept)
    const omitted = pointers.length - kept
    const tail = omitted > 0 ? [`(${omitted} more pointers omitted)`] : []
    return `${prefix}\n${body}\nPointers:\n${[...lines, ...tail].join('\n')}\n`
  }
  // Fewest-first search for the largest pointer count that fits: render is monotone in `kept`.
  let low = 0
  let high = pointers.length
  if (estimateTokens(render(0)) > cap) {
    throw new Error('brief_too_large')
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokens(render(mid)) <= cap) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  const text = render(low)
  return { prefix, text, tokens: estimateTokens(text) }
}
