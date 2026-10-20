# Guildhall

A governed agent-operations platform played as a guild game. `GLOSSARY.md` is binding: use its terms in code names, issues, PRs and docs, never its _Avoid_ words. Decisions live in `docs/adr/`; read the ones touching your area, and flag any change that contradicts one. The product spec is GitHub issue #6.

## Build Loop (ADR-0002)

- **Lead** (your session, Opus): runs one batch per fresh session with the `batch` skill. Holds pointers, not file contents, and stays under 40% of its context window: past that, finish the current step and continue in a fresh session from GitHub state.
- **Workers** (`worker` agent, Sonnet): one ticket each, in their own git worktree branched from the batch's integration branch; at most 4 at once, never two in the same area.
- **Explorer** (`explorer` agent, Haiku): every lookup that would pull many files into context.
- **Reviewer** (`reviewer` agent, Sonnet): only via the `review-loop` skill, for `risk` tickets and once per batch; max 2 rounds.
- All implementation happens in worktrees under `../tula.worktrees/<slug>`; the main checkout stays clean on `develop`.
- Agents never push to `develop` or `main`, never merge their own PR, and never add co-author trailers or generated-by footers.

## Definition of done

1. `bun run verify` is green (the `verify` skill; exactly what CI runs; the Stop hook enforces it).
2. Runtime changes: the `run-check` skill passes against the real compose stack.
3. `risk` tickets and every batch: the `review-loop` skill reports no blocking findings.
4. Every fixed bug or review finding starts with a failing regression test.

## Weekly maintenance

Always latest, majors included (Dependabot, grouped, targets `develop`). Each week merge the green Dependabot PRs; a major that breaks the gates becomes a ticket, not a hold-back.

## Token discipline

- Read only the ticket, this file, the `.claude/rules/*.md` matching the files you touch, and the files the ticket names.
- Briefs and reports are pointers (issue, path:line, test name, command and exit code, SHA), never pasted content.
- A ticket fits well under 35% of a worker's context; past 35%, stop and hand off.
- Read real exit codes; never judge a result from piped output.

## Fixed standards

Bun only; strict TypeScript with no shortcuts (no `any`, `as unknown as`, non-null `!`, `ts-ignore`/`ts-expect-error`, `biome-ignore` or `require`; narrow with Zod or type guards); Biome; JSDoc on every export; Zod for every boundary and for env (fail at boot); hexagonal layout (one composition root, every port has a memory adapter); `guild_id` on every tenant table with forced RLS and a cross-guild test; paginated lists; timeouts and jittered retries on outbound calls; idempotent retried handlers; no state in process memory; no model id in engine code. Governance (Seals, Treasury, caps, private routing, Bar the Gates) is deterministic code, never a model decision.

## Protected files

The `protect-files` hook blocks hand edits to `bun.lock` (use `bun add`/`bun remove`), `*.gen.ts` (rerun the generator), `.env*` except `.env.example`, and any migration already on `develop` (add a new one).

## Path-scoped rules

Area rules live in `.claude/rules/<area>.md` with `paths:` frontmatter and load only for matching files. Write a rule once, when its area's first code lands; never copy a rule.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `tejaspinjala/tula`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus `risk` for tickets that need per-ticket review. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
