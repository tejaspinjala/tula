---
name: verify
description: Run the repo's quality gate (`bun run verify`, exactly what CI runs), fix root causes, and rerun until green. Use before review, before committing, or when asked to verify or make CI pass.
---

# Verify

1. Run `bun run verify` from the worktree root and read its real exit code.
2. Green: report one line and stop.
3. Red: fix the **root cause**, never the symptom.
   - Biome: `bunx biome check --write .`, then fix the rest by hand. No `biome-ignore` without a same-line reason.
   - Types: fix them. No `any`, no `@ts-ignore`; `@ts-expect-error` only in tests, with a reason.
   - Tests: decide whether the code or the test is wrong. Never weaken an assertion or delete a test to get green.
4. Rerun. If the same failure survives 3 attempts, stop and report it with your diagnosis.

Report: `verify: green` or `verify: red after 3 attempts: <failure> — <diagnosis>`.
