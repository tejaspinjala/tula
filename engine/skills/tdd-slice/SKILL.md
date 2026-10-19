---
name: tdd-slice
description: Build one thin vertical slice test-first (red, green, refactor). Default loop for code.
---
# tdd-slice
A slice is one behaviour cut through every layer it touches. One failing test at a time; never write all tests up front.

## Slice
State the behaviour in one sentence and the acceptance check. If it needs more than ~5 files, split it and ask your manager.

## Red
Write exactly one test for the behaviour. Run it. It must fail for the right reason (missing behaviour, not a typo).

## Green
Write the least code that passes. No extra features, no speculative abstraction.

## Refactor
With tests green: remove duplication, improve names. Prefer deep modules (small interface, real work inside). Run the full suite.

## Done
Suite green, diff contains only this slice, docs written per docs-contract, learnings listed for the brain (retro). Report: tests run, files touched, open questions.
