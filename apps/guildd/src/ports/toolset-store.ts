/** The scope a role's tool list is frozen under: the Campaign id, or `quest:<id>` for a lone Quest. */
export function toolsetScope(campaignId: string | null, questId: string): string {
  return campaignId ?? `quest:${questId}`
}

/**
 * Port for frozen tool lists. The first call for a (scope, role) stores the list it is given and
 * every later call returns that stored list, ignoring its own, so a tool added to the catalogue
 * mid-Campaign is never exposed. First writer wins, even when callers race.
 */
export interface ToolsetStore {
  /** Freezes `tools` (ordered names) for the scope and role, or returns the list already frozen. */
  freeze(guildId: string, scope: string, role: string, tools: readonly string[]): Promise<string[]>
}
