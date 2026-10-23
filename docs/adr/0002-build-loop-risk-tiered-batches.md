# Build Loop: risk-tiered batches on integration branches

Guildhall is built by one lead session (Opus) that works the ticket graph in batches of about 3-6 related tickets. Each batch has an integration branch; each ticket goes to one Sonnet worker in its own git worktree, at most four at once, and merges into the integration branch once `verify` is green. Only tickets labelled `risk` (tenancy/RLS, Seals, Treasury, secrets, gateways, auth) get a per-ticket review, gated on green `verify`, by a fresh Sonnet reviewer reading only the diff and matching path rules, capped at 2 rounds. Every batch gets one review before its single PR into `develop`, which the Guild Master merges.

We chose this over closeline's PR-per-ticket with up to 4 review rounds, and over `/implement-spec`'s one review per spec, to minimise cost per accepted result: per-ticket PRs made blocked tickets wait on the Guild Master's merges, per-ticket review spent a reviewer's fixed setup cost on low-risk diffs that `verify` already covers, and one end-of-spec review saw diffs too large to review well and found bugs late, after the implementer's context was gone.

## Consequences

- Models are pinned in `.claude/agents/*.md` frontmatter (worker, reviewer and explorer all on Sonnet), not chosen per spawn. Amended 2026-10-22: the explorer moved from Haiku to Sonnet so every subagent runs on Sonnet; any ad-hoc subagent the lead spawns is also pinned to Sonnet.
- The ECC GateGuard hook is disabled for this repo; the repo's own hooks (protect-files, format-on-edit, fingerprinted Stop gate, short SessionStart block) carry enforcement, because GateGuard's fact-forcing re-asks cost tokens on every first edit and Bash call.
- Each batch runs in a fresh lead session that reads only pointers (phase plan, issues, integration branch); state never lives in a session, so no `/compact` between batches.
- Tickets are sized to fit well under 35% of a worker's context window; a worker that crosses 35% anyway stops, writes a short handoff (done, not verified, next) and the lead starts a fresh worker from it. Briefs are pointers (ticket, files, acceptance criteria), never pasted content.
