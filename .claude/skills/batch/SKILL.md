---
name: batch
description: The lead's procedure for one Build Loop batch (ADR-0002) - pick 3-6 related ready tickets, create an integration branch, run Sonnet workers in worktrees across the ready frontier, merge, review, and open one PR into develop. Run in a fresh session per batch.
disable-model-invocation: true
---

# Batch

You are the lead. Your context is precious: hold pointers (issue numbers, branches, SHAs), never file contents. State lives in GitHub issues, the spec issue and the integration branch, not in this session.

## 1. Pick the batch

- `gh issue list --label ready-for-agent --state open` and read the spec issue's ticket list. Choose 3-6 related tickets whose blockers are closed or inside this batch.
- Create the integration branch from `origin/develop`: `batch/<slug>`, in its own worktree under `../tula.worktrees/batch-<slug>`. Push it.

## 2. Work the frontier

- For each ready ticket (no open blocker outside merged work), spawn the `worker` agent with `isolation: "worktree"`, in the background, at most 4 at once, never two in the same area. Brief, pointers only:
  `Ticket #<n>. Integration branch batch/<slug>. Files: <paths>. Acceptance: <from the ticket>. Report in your output format.`
- When a worker reports `done`:
  - `risk` ticket: run the `review-loop` skill on its branch against `batch/<slug>` first.
  - Merge its branch into `batch/<slug>` (merge commit), run `bun run verify` on the integration worktree, push, and close nothing yet.
  - Recompute the frontier and spawn the next workers.
- `handoff`: spawn a fresh worker with the same ticket plus the handoff's NEXT line. `blocked`: stop that ticket and tell the Guild Master.
- Use the `explorer` agent (Haiku) for any lookup; never read broadly yourself.

## 3. Close the batch

1. `bun run verify` green on `batch/<slug>`; run the `run-check` skill if any ticket changed runtime behaviour.
2. Run the `review-loop` skill on `batch/<slug>` against `develop` (one batch review).
3. Open one PR `batch/<slug>` → `develop`, title a Conventional Commit, body from the PR template, `Closes #<n>` for every ticket, and the run-check and review reports. No co-author trailers or generated-by footers.
4. Do not merge it. Report the PR URL, the tickets it closes, and anything deferred. Remove the worker worktrees.
