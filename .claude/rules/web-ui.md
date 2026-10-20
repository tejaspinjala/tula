---
paths:
  - apps/web/src/**/*.tsx
  - apps/web/src/**/*.css
  - apps/web/src/hall/**
  - apps/web/src/builder/**
  - apps/web/src/workflows/**
---

# Web UI

- Every visual change follows the `pixel-ui` skill (load it before styling): the cozy pixel game language, its tokens, its components in `apps/web/src/ui/pixel/`, and its banned "AI slop" checklist.
- Pages compose `ui/pixel/` components and read only `tokens.css` variables: no raw colours, no raw `px`, no `border-radius`, gradients, blur or emoji.
- No Nintendo, Game Freak or ConcernedApe material; every third-party asset gets a `CREDITS.md` line.
- Done means driven in a real browser with screenshots at 390 and 1280, day and night, plus a keyboard-only pass.
