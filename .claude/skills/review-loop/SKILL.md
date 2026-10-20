---
name: review-loop
description: Gated, capped review per ADR-0002. Runs the reviewer agent on a risk-labelled ticket's branch or on a batch's integration branch, fixes accepted findings test-first, and stops after 2 rounds. Use only for `risk` tickets and once per batch before its PR.
---

# Review loop (max 2 rounds)

Keep a findings ledger in the conversation: `id | severity | where | status | resolution`.

## When

- A ticket labelled `risk` (tenancy/RLS, Seals, Treasury, secrets, gateways, auth): review its branch against the integration branch before merging it.
- Every batch: review the integration branch against `develop` once, before its PR.
- Any other ticket: no review; green `verify` is enough.

## Each round

1. **Gate.** `bun run verify` must be green (use the `verify` skill). Never spend a review on red code.
2. **Review.** Spawn the `reviewer` agent with the base branch. Round 2 prompt: "Round 2 re-review. Previous findings: <ledger rows>. Check each, then review the interdiff since round 1."
3. **Triage** each finding against the code yourself: 🔴/🟠 must be fixed; 🟡 fixed or deferred with a written reason and an issue; 🔵 optional. Dismiss only with evidence (file:line or test name).
4. **Fix test-first:** a regression test that fails, the smallest fix, the affected tests green.
5. **Exit** when verify is green and the verdict is `no blocking findings`. After round 2 without converging, stop and report the open findings; the lead decides.

## Final report (paste into the PR's "Review" section)

```
Review: <converged in N rounds | stopped after 2 rounds>
Verdict: <verdict>
Fixed:     F1 🟠 <path:line> — <what> → test '<name>'
Dismissed: F2 🟡 — <evidence>
Deferred:  F3 🟡 — #<issue>
```
