---
type: plan
version: 1.0
spec: docs/SPEC.md (v1.0)
updated: 2026-10-18
---
# Phase 0-1 Build Plan

**Goal of this plan:** go from today's scaffold to the first end-to-end slice (C15). Tej drops a learning → the brain files it → a scheduled LinkedIn draft is written → a fresh verifier (plus a cross-family judge when one is linked) issues a Verdict bound to the content hash → Tej approves on his phone → Tej copies the text and posts by hand → marks it posted with the URL. The phone approvals inbox, the kanban and a simple pixel office show all of this live.

## 0. Ground rules for building

- **Who builds Phase 0-1:** the fleet can't build itself yet. Tej runs Claude Code sessions in `~/TULA-PROJECTS/tula-fleet`. Each slice runs in its own **git worktree + branch** (`p1-05-dispatcher`), built by a subagent with the role/tier listed. A separate fresh **Verifier** session checks each slice against its tests and acceptance before merge. From Phase 2 the Product department takes over this loop.
- **Role → model tier:** Coder-mid = Sonnet-class. Coder-deep = Opus-class (security-critical or cross-cutting). Coder-cheap = Haiku-class (mechanical). Verifier = mid, fresh context. A judge from a different family (Codex) is used for P0-4, P1-3 and P1-5 when linked.
- **Definition of done for every slice:** `bun test` green, `bun run typecheck` (strict) green, the slice's listed tests exist and pass, the acceptance check passes as a command or recorded demo, the docs note says what the code *does* (docs-contract skill), and there's a handoff in the PR description (owner, inputs, done-condition, evidence).
- **Avoiding conflicts:** every slice owns its directories. Shared registries use **one file per module**: fleetd modules export `register(app, ctx)` from `engine/fleetd/<module>/index.ts`, and only the integrator edits `engine/fleetd/modules.ts` (a one-line add per slice, merged last). Schemas live in `engine/schema/<entity>.ts`, one file per entity, re-exported by a generated `index.ts`.
- **Sizes:** S ≈ under half a day of agent work + review. M ≈ 1 day. L ≈ 2-3 days.

## 1. Repo layout to create

```
tula-fleet/
  package.json  tsconfig.json  bunfig.toml  .github/workflows/ci.yml
  AGENTS.md  CLAUDE.md                    # generated, ≤40 lines, identical rules
  engine/
    cli/fleet.ts                          # init | start | stop | sync | doctor | approve | reindex | eval | backup
    schema/{task,run,handoff,spend-request,approval,access-grant,event,scorecard,verdict,goal,department,role,agent,channel,account}.ts
    schema/json/*.schema.json             # exported from Zod by `bun run schema:export` (checked in, CI diff-checked)
    lib/{store.ts,lock.ts,chain.ts,paths.ts,ids.ts,redact.ts,crypto.ts,config.ts}
    fleetd/
      server.ts  modules.ts
      auth/  ws/  kill/  lease/
      tasks/  approvals/  policy/  dispatcher/  router/  brief/  handoff/
      metrics/{otlp.ts,scorecard.ts,detectors.ts}
      brain/{intake.ts,compile.ts,search.ts,read.ts,lint.ts}
      scheduler/  verify/  publish/  audit/
    gateway/{server.ts,tools/*.ts}        # MCP stdio server, one file per tool group
    adapters/{types.ts,claude-code/,fleet-loop/}
    hooks/{policy-check.ts,event-log.ts,ctx-report.ts,session-start.ts}   # thin clients of fleetd
    prompts/{common.md,roles/*.md}
    skills/<name>/SKILL.md
    templates/org-full-life/              # C10 starter org
  ui/                                     # Vite + React + Tailwind + PixiJS
    src/{api/,inbox/,kanban/,office/,shared/}
  company.example/                        # fake company used by tests + cloners
  tests/{unit,contract,e2e,fixtures}/
  evals/golden/{writer,verifier,intake-router}/
  docs/{SPEC.md,PHASE-1-PLAN.md}
$FLEET_HOME (default ~/.tula-fleet)       # created by `fleet init`, never inside the repo
  company.json org/ brain/ tasks/ runs/ approvals/ grants/ audit/ staging/ evals/ state/ host.json
```

## 2. Backlog (ordered)

Legend: **Par** = parallel group (slices in the same group can be built at the same time in separate worktrees once the "after" slices are merged).

### Phase 0: Foundations and scaffold fixes

| ID | Slice | Size | Builder | Par / after |
|---|---|---|---|---|
| P0-1 | Repo hygiene + strict TS | S | Coder-mid | serial, first |
| P0-2 | Schemas (Zod → JSON Schema) | M | Coder-mid | A, after P0-1 |
| P0-3 | Store, locks, hash chains | M | Coder-deep | A, after P0-1 |
| P0-4 | Approvals rewrite (fixes self-approval + early consume) | M | Coder-deep + judge | B, after P0-2, P0-3 |
| P0-5 | Event/ctx race fix | S | Coder-mid | B, after P0-3 |
| P0-6 | `$FLEET_HOME`, config, `fleet doctor`, age key | M | Coder-mid | B, after P0-2, P0-3 |
| P0-7 | Full-life org template + claude-code generator | M | Coder-mid | B, after P0-2 |

**P0-1 Repo hygiene + strict TS.** Goal: a clean, typed baseline. Touches `package.json`, `tsconfig.json`, `fleet/**` → `engine/**` (git mv), `.github/workflows/ci.yml`, `engine/prompts/common.md`. Removes scripts pointing at missing files (`doctor`, `brain:lint`, `canvas`, `dash`, `demo`, `access`) and the `new-adr.ts` reference. Pins `@types/bun` and `typescript`. `strict: true`. Types for `route.ts`, `core.ts`, hooks. Gives `skill.ts` a real `--index` flag. Tests: `tests/unit/scripts-exist.test.ts` (every script target exists), `tests/unit/router.test.ts` (existing behaviour preserved), `tests/unit/skill.test.ts`. Accept: `bun install && bun test && bun run typecheck` all green in CI.

**P0-2 Schemas.** Goal: the data contracts in section 3, as Zod + exported JSON Schema. Touches `engine/schema/*`, `package.json` (`schema:export`). Tests: round-trip valid fixtures, rejection of invalid fixtures per schema, a CI check that the export is up to date. Accept: `bun run schema:export --check` passes, and every section 3 schema has ≥ 2 valid and ≥ 2 invalid fixtures.

**P0-3 Store, locks, hash chains.** Goal: one safe write path. `store.write(path, data, schema)` = validate → temp file → fsync → rename, under a per-file lock (`lock.ts`: O_EXCL lockfile + stale-lock timeout). `chain.append(file, event)` = append-only JSONL with `seq`, `prevHash`, `hash`. `chain.verify(file)`. Touches `engine/lib/{store,lock,chain,ids,paths}.ts`. Tests: 50 concurrent writers lose no updates, a crash mid-write leaves the old file intact (simulated), a tampered line fails `verify`. Accept: the concurrency test passes 20 runs in a row.

**P0-4 Approvals rewrite.** Goal: fix the two verified approval bugs. Approvals live in `$FLEET_HOME/approvals/approvals.jsonl` (chain), with states `pending → approved → reserved → consumed | released | expired | denied`. They're bound to `actionHash`, `usesLeft: 1`, `expiresAt`. The gate gets a hard deny for agent writes under `$FLEET_HOME/{approvals,grants,audit,ledger,org,tasks}` and the legacy `fleet/approvals/**`. Touches `engine/fleetd/approvals/*`, `engine/hooks/policy-check.ts` (interim local version), `engine/cli/fleet.ts approve`. Tests: `self-approval.test.ts` (Write to an approval path is denied, and even a file forced in by hand doesn't authorize anything), `consume-after-success.test.ts` (failing tool → `released`, approval still usable; success → `consumed`), `expiry.test.ts`, `hash-binding.test.ts` (an edited action needs a new approval). Accept: all four pass, and a verifier session tries 5 bypass ideas and documents each result.

**P0-5 Event/ctx race fix.** Goal: no read-modify-write in hooks. `event-log.ts` and `ctx-report.ts` only append one JSON line (< 4 KB) to `runs/_hooks/events.jsonl`. Linking uses `agent_id`. Derived link/ctx state moves into fleetd (temporarily a pure function `deriveState(events)` until P1-1). Touches `engine/hooks/*`, `engine/fleetd/metrics/derive.ts`. Tests: 2 parallel same-type spawns link to the right parents, 100 parallel hook processes produce no lost lines. Accept: tests pass, and no hook writes any file except by append.

**P0-6 `$FLEET_HOME`, config, doctor, keys.** Goal: a portable root and a health check. `paths.ts` resolves everything relative to `FLEET_HOME`. `config.ts` loads and validates `company.json` + `org/*.json`. `fleet doctor` checks bun/git versions, disk encryption (`fdesetup status` on macOS / `cryptsetup`/`lsblk` on Linux), `claude` logged in, `codex` present/logged in, Ollama `:11434`, LM Studio `:1234`, Infisical CLI login, free port. `fleet keys init` generates the age identity → OS keychain, plus a recovery recipient that is printed once. Touches `engine/lib/{paths,config,crypto}.ts`, `engine/cli/doctor.ts`, `engine/cli/keys.ts`. Tests: config rejects `private` on a non-allowed provider (C13 load-time check), doctor JSON output fixtures, age encrypt/decrypt round trip. Accept: `fleet doctor --json` on Tej's laptop reports every check, and an unencrypted disk is flagged `fail`.

**P0-7 Full-life org template + generator.** Goal: C10 org as files, with Claude agent files generated from them. `engine/templates/org-full-life/{departments,roles,agents,portfolio,goals,schedules,accounts,providers,limits}.json` per SPEC 8.4 (CoS replaces `tej`). Each role gets minimal `nativeTools`, `readScopes`, `writeScopes`, `shellAllow`. `adapters/claude-code/generate.ts` (from `sync-agents.ts`) emits frontmatter `name, description, model, tools, disallowedTools, maxTurns, mcpServers: [fleet], omitClaudeMd (employees)`. Tests: snapshot of generated files, `fleet sync --check`, every role's write scopes avoid governed paths, private departments have `dataClass: private`. Accept: `fleet sync` writes `.claude/agents/*.md`, and the CI check is green.

### Phase 1: Runtime, slice and UI

| ID | Slice | Size | Builder | Par / after |
|---|---|---|---|---|
| P1-1 | fleetd skeleton: Hono, auth, WS bus, lease, kill switch | M | Coder-mid | C, after P0 |
| P1-8 | Brain service (intake, compile, search, read, lint) | M | Coder-mid | C, after P0 (pure library first) |
| P1-11 | Approvals inbox UI (phone) on a mock API | M | Coder-mid | C, after P0-2 (UI uses the schemas only) |
| P1-12 | Kanban UI on a mock API | S | Coder-mid | C, after P0-2 |
| P1-13 | Simple pixel office on recorded events | M | Coder-mid | C, after P0-2 |
| P1-2 | MCP gateway core + skill tools + scope token | M | Coder-deep | D, after P1-1 |
| P1-4 | Task store, state machine, task tools, board API | M | Coder-mid | D, after P1-1 |
| P1-7 | Metrics: OTLP receiver, scorecards, detectors | M | Coder-mid | D, after P1-1 |
| P1-9 | Scheduler with catch-up, pause/postpone | S | Coder-mid | D, after P1-1 |
| P1-3 | Policy: scopes, policy-check hook, access request/grant/escalate | M | Coder-deep + judge | E, after P1-2, P1-4 |
| P1-5 | Dispatcher + router v2 + brief + claude-code adapter + data-class routing | L | Coder-deep + judge | E, after P1-2, P1-4 |
| P1-6 | Handoff contract + 35% handoff-and-restart | M | Coder-mid | F, after P1-5 |
| P1-10 | Content pipeline: intake router, writer, verifier, judge, verdict, publish.stage | M | Coder-mid | F, after P1-5, P1-8 |
| P1-14 | Wire UI to live API + ntfy push | S | Coder-mid | F, after P1-4, P1-11..13 |
| P1-15 | Backup (restic) + restore test | S | Coder-cheap | F, after P0-6 |
| P1-16 | Portability: fleet-loop adapter (local/OpenAI-compatible) + Codex probe | M | Coder-mid | G, after P1-6 |
| P1-17 | `fleet init` wizard (CLI) for cloners | S | Coder-mid | G, after P0-7, P1-1 |
| P1-18 | End-to-end slice + golden tasks + demo | M | Coder-deep (integrator) | H, after all |

**P1-1 fleetd skeleton.** Hono on `127.0.0.1:7420`. Owner auth: a bearer token generated at init, stored in the keychain, set as an httpOnly cookie for the UI via a one-time pairing link/QR for the phone. WS `/events` fans out normalized Events. `lease.ts` (single active instance). `kill/` watches `$FLEET_HOME/STOP` and `POST /kill`, broadcasts `kill.on`, and exposes `isKilled()`. Tests: auth required on every mutating route, a second fleetd instance refuses to start, the STOP file flips state within 1 s. Accept: `fleet start` serves `/health`, and the WS client receives a test event.

**P1-8 Brain service.** `intake(text, source)` → `brain/raw/YYYY-MM-DD-<slug>.md` (`trust: owner|web|agent`). `compile` helpers: write a wiki note only with `evidence:` for fact/pattern types, else force `assumptions/`. `search` = SQLite FTS5 over non-private notes. `read(path, section?)` returns a single section. `lint` (deterministic): missing evidence, broken links, orphans, secret patterns (hard fail), private→non-private links. Private notes go through age (`*.md.age`). Touches `engine/fleetd/brain/*`. Tests: a fact without evidence is rejected, a secret pattern makes lint fail, a private note never appears in FTS results, section read returns only that section. Accept: `bun engine/cli/fleet.ts brain lint` runs clean on `company.example`.

**P1-11 Approvals inbox UI.** Mobile-first list → detail. The detail shows the draft text, variant picker, Verdict badge (pass/fail, independence strong/weak), evidence list, claims ↔ fact links, ToS badge. Actions: Approve / Edit (inline; edit = new hash) / Reject with reason / Postpone, plus **Copy text** and **Mark posted (URL)**. Built against the schemas with an MSW mock. Tests: component tests for each action, Lighthouse mobile ≥ 90 for the inbox route. Accept: a demo video on a phone-sized viewport where every action takes one tap.

**P1-12 Kanban UI.** Columns = Task status. Card shows owner avatar, Goal color, tier, cost so far, approval/verdict chips. Filter by Goal/Department. Read-only drag (Owner-legal transitions only: cancel, reprioritize). Tests: renders fixtures, filter works. Accept: the board renders 200 tasks under 100 ms.

**P1-13 Simple pixel office.** PixiJS canvas. Rooms generated from `departments.json` (dormant rooms dimmed), a CEO office for Tej, a conference room. One avatar per active agent with status (idle/working/blocked/waiting approval). Speech bubble with the latest `msg.delegate`/`msg.report` text (click opens the full text). Plays back a recorded `events.jsonl`. Walking to the conference room is stubbed as a straight-line tween (pathfinding comes with meetings in Phase 2). Tests: the event → sprite-state reducer is unit-tested, and a replay fixture renders without errors. Accept: replay of the E2E fixture shows the Writer working → Verifier → "awaiting Tej".

**P1-2 MCP gateway core.** A stdio MCP server spawned per Run with `FLEET_SCOPE_TOKEN` (HMAC-signed JSON: runId, agentId, roleId, scopes, dataClasses, expiresAt). Tool registry with per-tool required scope, uniform error shape, and the kill-switch check on every call. Implements `skill.index`, `skill.section`, `decision.log`, `evidence.attach`. Tests: an unsigned or expired token is rejected, a tool outside the role's `gatewayTools` returns `denied_scope`, the kill switch returns `killed`. Accept: Claude Code lists the tools and calls `skill.index` in a smoke Run.

**P1-4 Tasks.** `tasks/<id>.md` (frontmatter = Task schema, body = log). State machine with allowed transitions per actor (agent/manager/owner/system). `task.get`, `task.list`, `task.update` (status/notes, with transition checks), `task.create` (Managers + CoS only), REST for the board. Tests: illegal transitions rejected, single owner enforced, `done` requires a done-condition result or a Verdict. Accept: create → ready → running → verify → awaiting_approval → done via the API, with an audit entry per transition.

**P1-7 Metrics.** OTLP/HTTP receiver at `:4318` (`OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) for Claude Code metrics/events. Normalizes to Event + Scorecard. Joins on `fleet.run_id` from `OTEL_RESOURCE_ATTRIBUTES`. Detectors: stuck (no tool call for 5 min), loop (same tool+args hash 5 times), ctx > 35%, gate thrash. Token cap accounting ($10/day, C12) with a queue-until-midnight rule. Tests: recorded OTLP fixtures → expected scorecards, detector fixtures. Accept: a real Claude Code Run shows tokens/cost/turns/peak ctx in `runs/<id>/scorecard.json` (also verifies A15).

**P1-9 Scheduler.** Cron (5-field, tz-aware), `catchUp: once|skip|all`, pause/postpone/skip-next via REST, per-fire cost cap, auto-pause after 3 failures. Template: weekday 08:30 LinkedIn draft, 07:30 digest. Tests: a fake clock with a laptop asleep 2 days → one catch-up fire, postpone respected. Accept: a schedule fires on a fake clock in CI and in real time on the laptop.

**P1-3 Policy and access.** `policy/scope.ts` (path globs, shell prefixes, tools, data classes). `POST /policy/check` used by `hooks/policy-check.ts` for Read/Write/Edit/Bash/MCP, **failing closed** if fleetd is unreachable. Gateway tools `access.request` and `access.grant` (Managers+). Escalation chain Manager → Director → CoS → Owner. **Grant ≤ granter authority** (scope subset check). Auto-rule for in-project reads. Expiry. Tests: an employee write outside scope is denied; a manager can't grant beyond its own scope (escalates); an expired grant is denied; private data requested by a non-private department goes straight to the Owner; hook fails closed when fleetd is down. Accept: a scripted Run hits a denial, requests access, the Manager grants it for 60 min, the action succeeds, and the grant expires.

**P1-5 Dispatcher + adapter.** The ready-Task picker (Portfolio fair share + WIP limits). Router v2 (keyword + cheap classifier fallback + escalation). `brief.ts` (task, acceptance, done-condition, file paths, skill section names, scopes, data-class allowance, coaching notes slot). The claude-code adapter: `claude -p --output-format stream-json` with the agent definition, the MCP config pointing at the gateway, env scrubbed to an allow-list, OTel env, a worktree for code tasks. `classifyError`. **Data-class routing:** `privateAllowed()` engine constant + `classChains.private` + fail closed (C13). Tests: a private Task with Claude Max marked degraded → `blocked: private_provider_unavailable`, **never** routed to codex/api (contract test across all configured providers); router fixtures; brief contains paths and not file contents; env scrub test (no `*_KEY`/`*_TOKEN` passed). Accept: a cheap Task runs end-to-end on Claude Max with a scorecard, and the private fail-closed test passes.

**P1-6 Handoff and 35% restart.** `handoff.write` validates owner/inputs/doneCondition/status/evidence. The adapter synthesizes a `trust: auto` handoff when missing (events + `git diff --stat` + last message). Ctx reports from the hook (`ctx-report.ts`) or adapter: at 30% inject "finish unit", at 35% force a handoff, stop the Run and re-queue with `resumeFrom`. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=35` stays as a backstop. Tests: an incomplete handoff is rejected; a ctx fixture at 36% triggers stop + re-queue; the resumed Brief includes the handoff path and the "verify from files" line. Accept: a long fixture task crosses 35% and completes in 2 Runs, with peak ctx < 40% in both.

**P1-10 Content pipeline.** Roles and prompts: Intake Router (cheap), Curator/Compiler (cheap), LinkedIn Manager (coordinator), Writer (mid), Editor (cheap), Verifier (mid, fresh), Judge (mid, other family if linked, else flagged `weak`). `publish.stage` writes `staging/linkedin/<date>-<slug>.md` + `contentHash`. `verify.submit` (verifier/judge findings with `ruleKey`). `verdict.issue` (coordinator, bound to `contentHash`). Approval is created with kind `publish`, mode `manual`, method `copy`. **Mark posted** stores the URL as evidence. Skills: `verify`, `judge-rubric`, voice rules note in `brain/wiki/brand/voice.md`. Tests: an edited draft invalidates the Verdict; a claim without a fact link fails verification; the verifier gets no Writer transcript (Brief inspection). Accept: from a fixture learning, the pipeline produces a staged draft with a passing Verdict and a pending Approval.

**P1-14 Wire UI to live API + push.** Swap mocks for REST/WS. ntfy push (topic from config; self-hosted or ntfy.sh) on a new approval, with a deep link to the inbox item. Tests: an API contract test using the JSON Schemas, a push payload test. Accept: Tej gets a push on his phone and approves over Tailscale.

**P1-15 Backup.** `fleet backup` = restic to the configured local target (S5), excluding derived files. `fleet backup verify` = restore to a temp dir + chain verify + decrypt a sample private note. Restic password from Infisical `/backup` (or keychain until Infisical is linked). Tests: a backup/restore round trip on `company.example`. Accept: nightly job scheduled, and the first restore test passes.

**P1-16 Portability proof.** fleet-loop adapter: an OpenAI-compatible chat loop with gateway tools (MCP client inside fleetd) for loopback-local endpoints (Ollama/LM Studio) and API keys. Codex probe: detect + `codex exec --json` smoke run with the fleet MCP server configured (verifies A17). Failover on `rate_limit`/`credits_exhausted`. Tests: a forced 429 fixture → failover → resume from handoff; a private Task never goes to fleet-loop with a non-loopback baseUrl. Accept: a public draft task resumed on a second provider produces a staged draft.

**P1-17 `fleet init` wizard (CLI).** Steps from SPEC 6.7, with the full-life template, accounts step (C16: vendor/handle only), providers detection, money mode paper, token cap. Writes `$FLEET_HOME`, runs `fleet sync`, prints the phone pairing QR. Tests: non-interactive `--answers file.json` mode produces a valid company. Accept: a fresh clone → `bun install && bun fleet init --answers company.example/answers.json && bun fleet start` in under 10 minutes.

**P1-18 E2E slice + golden tasks.** `tests/e2e/learning-to-post.test.ts` runs the whole slice with a fake clock and the real Claude Max provider (tagged `@live`, run manually) plus a recorded-provider variant for CI. Golden tasks: 3 each for Writer, Verifier and Intake Router. Demo script. **Acceptance (= Phase 1 exit):**
1. A learning dropped at 21:00 → verified draft staged by 08:35 the next weekday.
2. One-tap approve on the phone. Copy text. Mark posted with URL. Task `done` with evidence.
3. Scorecards show tokens/cost/peak ctx per Run and cost per accepted post. Daily token cap enforced.
4. `touch $FLEET_HOME/STOP` halts a running Run within 2 s.
5. A Health-department task with Claude Max unavailable **pauses** (no fallback).
6. A self-approval attempt is denied and logged. An access request → grant → expiry works.
7. The same draft task resumes on a second provider from its handoff.
8. The office shows Writer → Verifier → "awaiting Tej" live. The kanban reflects every transition.
9. The backup restore test passes.

## 3. Data contracts (JSON Schema 2020-12; Zod in `engine/schema/` is canonical, these are the exported shapes)

Shared definitions (`common.schema.json`):
```json
{
  "$id": "common",
  "$defs": {
    "ulid": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "ts": { "type": "string", "format": "date-time" },
    "tier": { "enum": ["cheap", "mid", "deep"] },
    "dataClass": { "enum": ["public", "internal", "private", "secret"] },
    "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "usd": { "type": "number", "minimum": 0 },
    "scope": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "read": { "type": "array", "items": { "type": "string" } },
        "write": { "type": "array", "items": { "type": "string" } },
        "shell": { "type": "array", "items": { "type": "string" }, "description": "allowed command prefixes" },
        "gatewayTools": { "type": "array", "items": { "type": "string" } },
        "nativeTools": { "type": "array", "items": { "type": "string" } },
        "netDomains": { "type": "array", "items": { "type": "string" } },
        "dataClasses": { "type": "array", "items": { "$ref": "#/$defs/dataClass" } },
        "usd": { "$ref": "#/$defs/usd" },
        "tokens": { "type": "integer", "minimum": 0 }
      }
    },
    "evidenceRef": {
      "type": "object", "additionalProperties": false, "required": ["kind", "ref"],
      "properties": {
        "kind": { "enum": ["test_output", "command_log", "commit", "screenshot", "video", "file_line", "url", "metric", "brain_note"] },
        "ref": { "type": "string" }, "sha256": { "$ref": "#/$defs/sha256" }, "note": { "type": "string", "maxLength": 300 }
      }
    },
    "doneCondition": {
      "type": "object", "additionalProperties": false, "required": ["kind", "spec"],
      "properties": { "kind": { "enum": ["command", "tests", "schema", "rubric"] }, "spec": { "type": "string" }, "timeoutSec": { "type": "integer", "minimum": 1, "default": 300 } }
    }
  }
}
```

**Task**
```json
{
  "$id": "task", "type": "object", "additionalProperties": false,
  "required": ["id", "projectId", "goalId", "title", "ownerAgentId", "acceptance", "doneCondition", "status", "priority", "risk", "dataClass", "createdAt", "updatedAt", "version"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "projectId": { "type": "string" }, "goalId": { "type": "string" },
    "departmentId": { "type": "string" }, "parentTaskId": { "$ref": "common#/$defs/ulid" },
    "title": { "type": "string", "maxLength": 140 },
    "ownerAgentId": { "type": "string", "description": "exactly one owner" },
    "taskType": { "type": "string", "description": "routing key, e.g. post.draft, brain.compile, verify" },
    "acceptance": { "type": "array", "minItems": 1, "items": { "type": "string" } },
    "doneCondition": { "$ref": "common#/$defs/doneCondition" },
    "status": { "enum": ["backlog", "ready", "running", "verify", "blocked", "awaiting_approval", "done", "cancelled"] },
    "blockedReason": { "enum": ["deps", "provider", "private_provider_unavailable", "access", "approval", "budget", "killed", "other"] },
    "priority": { "type": "integer", "minimum": 0, "maximum": 3 },
    "risk": { "enum": ["low", "high"] },
    "dataClass": { "$ref": "common#/$defs/dataClass" },
    "flags": { "type": "array", "items": { "enum": ["external", "irreversible", "open_ok", "overnight", "hidden_tests", "urgent"] } },
    "deps": { "type": "array", "items": { "$ref": "common#/$defs/ulid" } },
    "inputs": { "type": "array", "items": { "type": "string" }, "description": "file/brain paths, never contents" },
    "proposal": { "type": "object", "properties": { "kind": { "enum": ["commit", "content"] }, "hash": { "type": "string" } }, "required": ["kind", "hash"] },
    "verdictId": { "$ref": "common#/$defs/ulid" }, "approvalId": { "$ref": "common#/$defs/ulid" },
    "estimateUsd": { "$ref": "common#/$defs/usd" }, "attempts": { "type": "integer", "minimum": 0 },
    "runIds": { "type": "array", "items": { "$ref": "common#/$defs/ulid" } },
    "dueAt": { "$ref": "common#/$defs/ts" },
    "createdAt": { "$ref": "common#/$defs/ts" }, "updatedAt": { "$ref": "common#/$defs/ts" }, "version": { "type": "integer" }
  }
}
```

**Run**
```json
{
  "$id": "run", "type": "object", "additionalProperties": false,
  "required": ["id", "taskId", "agentId", "roleId", "adapter", "provider", "family", "model", "tier", "startedAt", "status", "briefPath", "scopeTokenId"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "agentId": { "type": "string" }, "roleId": { "type": "string" },
    "purpose": { "enum": ["implement", "verify", "judge", "coordinate", "intake", "compile", "meeting_turn", "other"] },
    "adapter": { "enum": ["claude-code", "codex", "fleet-loop"] }, "provider": { "type": "string" },
    "family": { "type": "string" }, "model": { "type": "string" }, "tier": { "$ref": "common#/$defs/tier" },
    "dataClasses": { "type": "array", "items": { "$ref": "common#/$defs/dataClass" } },
    "status": { "enum": ["starting", "running", "ok", "failed", "handoff", "killed", "failover"] },
    "resumeFrom": { "type": "string", "description": "handoff path" },
    "briefPath": { "type": "string" }, "handoffPath": { "type": "string" }, "decisionLogPath": { "type": "string" },
    "scopeTokenId": { "type": "string" }, "worktree": { "type": "string" }, "osUser": { "type": "string" },
    "error": { "type": "object", "properties": { "class": { "enum": ["rate_limit", "credits_exhausted", "overloaded", "auth", "context", "tool", "other"] }, "message": { "type": "string", "maxLength": 500 } } },
    "startedAt": { "$ref": "common#/$defs/ts" }, "endedAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**Handoff**
```json
{
  "$id": "handoff", "type": "object", "additionalProperties": false,
  "required": ["runId", "taskId", "owner", "inputs", "doneCondition", "status", "evidence", "next", "trust", "writtenAt"],
  "properties": {
    "runId": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "owner": { "type": "string" },
    "inputs": { "type": "array", "items": { "type": "string" } },
    "doneCondition": { "$ref": "common#/$defs/doneCondition" },
    "status": { "enum": ["met", "not_met", "partial"] },
    "summary": { "type": "string", "maxLength": 1200 },
    "evidence": { "type": "array", "items": { "$ref": "common#/$defs/evidenceRef" } },
    "decisions": { "type": "array", "items": { "type": "string", "maxLength": 300 } },
    "changed": { "type": "object", "properties": { "files": { "type": "array", "items": { "type": "string" } }, "commit": { "type": "string" }, "contentHash": { "$ref": "common#/$defs/sha256" } } },
    "next": { "type": "array", "items": { "type": "string" } },
    "unverified": { "type": "array", "items": { "type": "string" } },
    "peakCtxPct": { "type": "number" },
    "trust": { "enum": ["agent", "auto"] },
    "writtenAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**SpendRequest** (schema fixed now for stability; flow ships in Phase 3, paper mode)
```json
{
  "$id": "spend-request", "type": "object", "additionalProperties": false,
  "required": ["id", "requesterAgentId", "goalId", "envelopeId", "amount", "currency", "vendor", "item", "why", "expectedRoi", "status", "mode", "createdAt"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "requesterAgentId": { "type": "string" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "goalId": { "type": "string" }, "envelopeId": { "type": "string" },
    "amount": { "type": "number", "exclusiveMinimum": 0 }, "currency": { "const": "USD" },
    "recurring": { "type": "object", "properties": { "every": { "enum": ["month", "year"] }, "until": { "$ref": "common#/$defs/ts" } } },
    "vendor": { "type": "string" }, "item": { "type": "string" }, "why": { "type": "string", "maxLength": 600 },
    "expectedRoi": { "type": "object", "required": ["metric", "value", "horizonDays"], "properties": { "metric": { "type": "string" }, "value": { "type": "number" }, "horizonDays": { "type": "integer" } } },
    "alternatives": { "type": "array", "items": { "type": "string" } },
    "mode": { "enum": ["paper", "real"] },
    "status": { "enum": ["draft", "finance_review", "owner_review", "approved", "denied", "executed", "expired"] },
    "checks": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "pass": { "type": "boolean" }, "detail": { "type": "string" } } } },
    "financeVerdict": { "type": "object", "properties": { "decision": { "enum": ["approve", "deny", "escalate"] }, "reasons": { "type": "array", "items": { "type": "string" } } } },
    "approvalId": { "$ref": "common#/$defs/ulid" }, "receipt": { "$ref": "common#/$defs/evidenceRef" },
    "expiresAt": { "$ref": "common#/$defs/ts" }, "createdAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**Approval**
```json
{
  "$id": "approval", "type": "object", "additionalProperties": false,
  "required": ["id", "kind", "actionHash", "summary", "requestedBy", "approverRequired", "status", "usesLeft", "createdAt", "expiresAt"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" },
    "kind": { "enum": ["publish", "spend", "deploy", "external", "org_change", "grant", "autonomy"] },
    "actionHash": { "$ref": "common#/$defs/sha256" },
    "taskId": { "$ref": "common#/$defs/ulid" }, "verdictId": { "$ref": "common#/$defs/ulid" },
    "summary": { "type": "string", "maxLength": 400 },
    "payloadRef": { "type": "string", "description": "path to staged item; never secrets" },
    "channel": { "type": "object", "properties": { "id": { "type": "string" }, "mode": { "enum": ["manual", "approve_then_auto", "auto_when_unavailable", "auto"] }, "method": { "enum": ["copy", "official_api", "browser"] }, "tosRisk": { "enum": ["low", "medium", "high"] } } },
    "requestedBy": { "type": "string" },
    "approverRequired": { "type": "string", "description": "'owner' | 'finance' | agentId" },
    "status": { "enum": ["pending", "approved", "reserved", "consumed", "released", "denied", "expired"] },
    "usesLeft": { "type": "integer", "minimum": 0, "maximum": 1 },
    "decidedBy": { "type": "string" }, "decidedAt": { "$ref": "common#/$defs/ts" }, "reason": { "type": "string" },
    "postponedUntil": { "$ref": "common#/$defs/ts" },
    "createdAt": { "$ref": "common#/$defs/ts" }, "expiresAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**AccessGrant** (the request is the same shape, with `status: requested|granted|escalated|denied|expired` and no `grantedBy`)
```json
{
  "$id": "access-grant", "type": "object", "additionalProperties": false,
  "required": ["id", "requestId", "agentId", "scope", "grantedBy", "granterAuthorityHash", "reason", "status", "createdAt", "expiresAt"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "requestId": { "$ref": "common#/$defs/ulid" },
    "agentId": { "type": "string" }, "runId": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "scope": { "$ref": "common#/$defs/scope" },
    "grantedBy": { "type": "string", "description": "agentId | 'policy:auto' | 'owner'" },
    "granterAuthorityHash": { "$ref": "common#/$defs/sha256", "description": "hash of granter's effective scope at grant time; grant must be a subset" },
    "escalationPath": { "type": "array", "items": { "type": "string" } },
    "reason": { "type": "string", "maxLength": 300 },
    "status": { "enum": ["active", "expired", "revoked"] },
    "maxUses": { "type": "integer", "minimum": 1 },
    "createdAt": { "$ref": "common#/$defs/ts" }, "expiresAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**Event** (the normalized stream: UI, metrics, replay)
```json
{
  "$id": "event", "type": "object", "additionalProperties": false,
  "required": ["ts", "type", "source"],
  "properties": {
    "ts": { "$ref": "common#/$defs/ts" },
    "type": { "enum": ["run.start", "run.end", "msg.delegate", "msg.report", "msg.human", "tool.call", "tool.result", "tool.denied", "usage", "ctx", "compact", "handoff", "error",
                       "task.transition", "approval.requested", "approval.decided", "verdict.issued", "access.requested", "access.granted", "access.escalated",
                       "detector.alert", "schedule.fired", "kill.on", "kill.off", "provider.degraded", "provider.recovered"] },
    "source": { "enum": ["hook", "adapter", "otel", "fleetd", "gateway", "ui"] },
    "runId": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "agentId": { "type": "string" }, "parentAgentId": { "type": "string" }, "from": { "type": "string" }, "to": { "type": "string" },
    "text": { "type": "string", "maxLength": 400, "description": "redacted; private-class text replaced by '[private]' outside private views" },
    "tool": { "type": "string" },
    "usage": { "type": "object", "properties": { "model": { "type": "string" }, "in": { "type": "integer" }, "out": { "type": "integer" }, "cacheRead": { "type": "integer" }, "cacheWrite": { "type": "integer" }, "costUsd": { "type": "number" }, "quotaUnits": { "type": "number" } } },
    "ctxPct": { "type": "number" },
    "data": { "type": "object", "description": "type-specific extras, schema per type in engine/schema/event.ts" }
  }
}
```

**Scorecard**
```json
{
  "$id": "scorecard", "type": "object", "additionalProperties": false,
  "required": ["runId", "agentId", "roleId", "provider", "model", "tokensIn", "tokensOut", "costUsd", "turns", "wallMs", "peakCtxPct", "outcome"],
  "properties": {
    "runId": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" }, "goalId": { "type": "string" },
    "agentId": { "type": "string" }, "roleId": { "type": "string" }, "provider": { "type": "string" }, "model": { "type": "string" },
    "tokensIn": { "type": "integer" }, "tokensOut": { "type": "integer" }, "cacheRead": { "type": "integer" },
    "costUsd": { "type": "number" }, "quotaUnits": { "type": "number" },
    "turns": { "type": "integer" }, "wallMs": { "type": "integer" }, "peakCtxPct": { "type": "number" },
    "retries": { "type": "integer" }, "gateDenials": { "type": "integer" }, "accessRequests": { "type": "integer" }, "helperCount": { "type": "integer" },
    "loopFlags": { "type": "array", "items": { "enum": ["stuck", "loop", "ctx_over", "gate_thrash", "waste"] } },
    "acceptanceMet": { "type": "boolean" }, "verdict": { "enum": ["pass", "fail"] }, "judgeIndependence": { "enum": ["strong", "weak"] },
    "reworkOf": { "$ref": "common#/$defs/ulid" }, "failover": { "type": "boolean" },
    "outcome": { "enum": ["ok", "failed", "handoff", "killed", "failover"] }
  }
}
```

**Verdict** (needed by P1-10; full Phase 1 contract)
```json
{
  "$id": "verdict", "type": "object", "additionalProperties": false,
  "required": ["id", "taskId", "proposalHash", "verifierRunId", "independence", "decision", "reasons", "issuedBy", "issuedAt"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" }, "proposalHash": { "type": "string" },
    "verifierRunId": { "$ref": "common#/$defs/ulid" }, "judgeRunId": { "$ref": "common#/$defs/ulid" }, "judgeFamily": { "type": "string" },
    "independence": { "enum": ["strong", "weak"] }, "decision": { "enum": ["pass", "fail"] },
    "reasons": { "type": "array", "items": { "type": "string" } },
    "findings": { "type": "array", "items": { "type": "object", "required": ["ruleKey", "severity", "text"], "properties": { "ruleKey": { "type": "string" }, "severity": { "enum": ["info", "minor", "major", "blocker"] }, "text": { "type": "string" }, "ref": { "type": "string" } } } },
    "evidence": { "type": "array", "items": { "$ref": "common#/$defs/evidenceRef" } },
    "issuedBy": { "type": "string" }, "issuedAt": { "$ref": "common#/$defs/ts" }
  }
}
```

## 4. Gateway MCP tools (Phase 1 only)

All tools take the caller identity from the Run's scope token (never from arguments). All return `{ ok: true, data }` or `{ ok: false, error: { code, message, hint?, want? } }` with `code ∈ denied_scope | needs_access | killed | invalid | not_found | conflict | budget_exceeded | private_provider_unavailable | rate_limited`. Every call is an Event, and mutating calls are audited.

| Tool | Who (default roles) | Input | Output |
|---|---|---|---|
| `task.get` | all | `{ taskId }` | `Task` (body log truncated to last 20 lines) |
| `task.list` | managers, CoS | `{ status?, goalId?, departmentId?, ownerAgentId?, limit≤50 }` | `{ tasks: TaskSummary[] }` |
| `task.create` | managers, CoS, Intake Router | `{ title, projectId, goalId, ownerAgentId, taskType, acceptance[], doneCondition, priority?, risk?, dataClass?, inputs?[], deps?[], dueAt? }` | `{ taskId }` |
| `task.update` | owner agent of the task; its manager | `{ taskId, status?, note?(≤500), blockedReason?, inputs?[] }` | `{ task: Task }` (illegal transition → `conflict`) |
| `handoff.write` | the Run's agent | `Handoff` minus `runId/taskId/trust/writtenAt` | `{ path }` (missing owner/inputs/doneCondition/evidence → `invalid`) |
| `decision.log` | all | `{ what(≤200), why(≤400), alternatives?[], reversible: boolean }` | `{ seq }` |
| `evidence.attach` | all | `{ kind, path \| url, note? }` (path must be inside the Run's workdir or `runs/<id>/`) | `EvidenceRef` (sha256 computed by fleetd) |
| `skill.index` | all | `{ name }` | `{ core: string, sections: { title, tokensEst }[] }` |
| `skill.section` | all | `{ name, section }` | `{ text, tokensEst }` |
| `brain.intake` | CoS, Intake Router, Owner (UI) | `{ text, source: 'owner'\|'web'\|'agent', url?, dataClass? }` | `{ path }` |
| `brain.search` | all with brain read scope | `{ q, type?, limit≤10 }` | `{ hits: { path, title, type, snippet(≤200) }[] }` (private excluded unless scope allows) |
| `brain.read` | all with read scope | `{ path, section? }` | `{ frontmatter, text }` (≤ 4k tokens; larger → must request a section) |
| `brain.write` | Curator, Compiler, Librarian | `{ path, type, title, body, evidence?[], links?[], dataClass }` | `{ path }` (fact/pattern without evidence → forced to `assumptions/`, returned path says so) |
| `publish.stage` | Writer, Editor | `{ channelId, text, variants?[], claims: { text, factPath }[], scheduledFor? }` | `{ stagedPath, contentHash }` |
| `verify.submit` | Verifier, Judge | `{ taskId, proposalHash, role: 'verifier'\|'judge', pass: boolean, findings[], evidence[] }` | `{ submissionId }` |
| `verdict.issue` | Coordinator (LinkedIn Manager) | `{ taskId, proposalHash, decision, reasons[] }` | `Verdict` (refused if the hash ≠ current staged hash, or the verifier is missing; creates the Approval automatically for `publish` tasks) |
| `access.request` | all | `{ want: Scope, why(≤300), durationMin?(≤1440), taskId? }` | `{ requestId, status: 'granted'\|'pending'\|'escalated' }` |
| `access.grant` | managers, directors, CoS | `{ requestId, scope?: Scope (≤ requested), durationMin?, deny?: boolean, reason }` | `{ grantId? , status }` (scope ⊄ granter authority → auto-escalates, `status: 'escalated'`) |
| `metrics.self` | all | `{}` | `{ ctxPct, tokensUsed, costUsd, runBudgetLeftUsd }` (lets agents self-pace without reading transcripts) |

Not in Phase 1 (schemas exist, tools ship later): `task.delegate` and `meeting.*` (Phase 2); `spend.*` and `experiment.*` (Phase 3); external `publish.execute` (Phase 4, publisherd only).

**REST (Owner/UI only, not MCP):** `GET /api/approvals`, `POST /api/approvals/:id/{approve,deny,postpone}`, `POST /api/approvals/:id/edit`, `POST /api/tasks/:id/posted {url}`, `GET /api/tasks`, `GET /api/runs/:id`, `GET /api/scorecards`, `GET/POST /api/schedules/:id/{pause,resume,postpone,skip}`, `POST /api/access/:id/{grant,deny}`, `POST /api/kill`, `DELETE /api/kill` (with reason), `GET /api/org`, `WS /events`.

## 5. Parallel build map

```
P0-1 ─┬─ P0-2 ─┬─ P0-4 ──┐
      └─ P0-3 ─┼─ P0-5   │
               ├─ P0-6   │
      P0-2 ────┴─ P0-7   │
                         ▼
   Wave C (5 worktrees): P1-1 · P1-8 · P1-11 · P1-12 · P1-13
   Wave D (4):           P1-2 · P1-4 · P1-7 · P1-9            (after P1-1)
   Wave E (2):           P1-3 · P1-5                          (after P1-2, P1-4)
   Wave F (4):           P1-6 · P1-10 · P1-14 · P1-15
   Wave G (2):           P1-16 · P1-17
   Wave H (1):           P1-18 (integrator, deep)
```
At most 5 worktrees at once on the laptop (WIP + Claude Max limits). The UI slices (P1-11/12/13) are the safest to parallelize because they build against schemas and mocks only.
