#!/usr/bin/env bash
# SessionStart: print a short status block that Claude receives as context. Keep it under ~10 lines;
# every session pays for it.
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$root" || exit 0

branch=$(git branch --show-current 2>/dev/null || echo '?')
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
worktrees=$(git worktree list 2>/dev/null | wc -l | tr -d ' ')

if command -v docker >/dev/null 2>&1 && docker compose ps --status running -q 2>/dev/null | grep -q .; then
  services=$(docker compose ps --status running --format '{{.Service}}' 2>/dev/null | tr '\n' ' ')
else
  services='not running'
fi

if [ -f .claude/.state/last-pass ]; then gate='last verify passed'; else gate='no recorded pass'; fi

cat <<MSG
Guildhall session ($branch, $dirty changed files, $worktrees worktrees)
- stack: $services | stop-gate: $gate
- Done = bun run verify green; risk tickets also /review-loop (max 2 rounds). Work in a worktree.
- Token discipline: read only what the ticket names; explore with the explorer agent (Haiku).
MSG
exit 0
