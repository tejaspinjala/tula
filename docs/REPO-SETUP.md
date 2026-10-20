# Repo setup

Everything GitHub-side is code in this repo and applied by one script.

## Branches (git-flow)

- `develop` is the default and integration branch; `main` is production and release-only.
- Work happens on `feat|fix|refactor|perf|build|ci|docs|test|chore/<slug>` from `origin/develop`, in its own git worktree, and lands by PR into `develop` with a merge commit once CI is green.
- A release is a PR from `release/<version>` into `main`; a hotfix is `hotfix/<slug>` into `main`, then `main` is merged back into `develop`.

## What enforces it

| Rule | Where |
|---|---|
| No deletion, force-push or direct push on `main`/`develop`; PR required; merge commits only; review threads resolved; no bypass actors | `.github/rulesets/protect-main-develop.json` |
| Required checks `verify` (`bun run verify`) and `pr-rules`, up to date with the base branch | same ruleset; jobs in `.github/workflows/ci.yml` |
| PR titles are Conventional Commits; only `release/*` or `hotfix/*` may target `main` | `pr-rules` job |
| Commit subjects are Conventional Commits | `.husky/commit-msg` |
| Format and typecheck before commit | `.husky/pre-commit` |
| Merge commits only, head branches deleted on merge, secret scanning with push protection | `REPO_SETTINGS` in `scripts/repo-setup.ts` |
| The ruleset, settings and commit-msg hook hold to the rules above | `scripts/repo-setup.test.ts` (part of `verify`) |

Required approvals are 0: GitHub does not let a PR's author approve it, and agent PRs are opened under the Guild Master's account. The `main` gate is the source-branch check plus green CI.

## Apply or re-apply

Needs admin rights on the repo:

```sh
bun install
bun run repo:setup            # or: bun run repo:setup <owner>/<repo>
```

It patches the repo settings, then creates or updates each ruleset in `.github/rulesets/` by name.
