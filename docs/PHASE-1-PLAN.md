---
type: plan
version: 1.1
spec: docs/SPEC.md (v1.1)
updated: 2026-10-18
---
# Phase 0-1 Build Plan

## CHANGELOG
- **1.1 (2026-10-18):** Re-planned for C17-C19 (nothing hard-coded). Phase 1 now has two milestones. **M1:** the C15 slice runs as the workflow template `wf-learning-to-linkedin` on a generic workflow engine with a `manual` connection. **M2:** every UI editor (workflow builder, org editor, connections + Create-team wizard, schedules, policy, providers, templates, first-run wizard). Added slices: config service, workflow validator/engine/simulator, connector framework, connections store, templates-as-data, UI form kit, editors. P1-9 became the trigger service. P1-10 became template data (P1-T2). P1-11..13 renumbered to P1-U1..U3. P1-17 merged into P1-U9. **P0-2 and P0-7 changed, P0-6 slightly, P0-1/3/4/5 unchanged.** New data contracts: Workflow, node types, WorkflowInstance, Team, Connection, ConnectorManifest, Template manifest, ConfigVersion. Task/Event extended.
- **1.0:** First plan (Phase 0 fixes → C15 slice with inbox, kanban, office).

**Goal of Phase 1:** a generic engine that runs whatever company Tej configures. It's proven by **M1**: importing the starter templates and running the C15 slice as a workflow (learning → verified LinkedIn draft → Tej approves on his phone → Tej posts by hand → marks it posted). Then **M2**: Tej can build and change teams, workflows, connections and policies himself in the UI.

## 0. Ground rules for building
- **Who builds:** Tej runs Claude Code sessions in `~/TULA-PROJECTS/tula-fleet`, one **git worktree + branch** per slice (`p1-w2-engine`), each built by a subagent with the role/tier listed. A fresh **Verifier** session checks each slice before merge. A cross-family judge (Codex, when linked) is used on the deep slices.
- **Tiers:** Coder-mid = Sonnet-class. Coder-deep = Opus-class (security-critical or cross-cutting). Coder-cheap = Haiku-class.
- **Definition of done:** `bun test` + strict `typecheck` green, the listed tests exist and pass, the acceptance check passes (command or recorded demo), the docs note says what the code *does*, and there's a handoff in the PR description.
- **No hard-coding rule (C17), checked in review:** engine code may not contain department/team/role/agent ids, workflow shapes, platform names outside `engine/connectors/<platform>/`, thresholds, prices or model ids. A lint (`scripts/no-hardcode.ts`, added in P0-7) greps engine code for template ids and fails CI.
- **Avoiding conflicts:** each slice owns its directories. fleetd modules register via `engine/fleetd/<module>/index.ts`. Only the integrator edits `engine/fleetd/modules.ts`. **Schemas have one owner** (P0-2). Later schema changes are small PRs reviewed by the integrator.
- **Concurrency cap:** at most 5 worktrees at once (laptop + Claude Max limits).
- **Sizes:** S ≈ under half a day of agent work + review. M ≈ 1 day. L ≈ 2-3 days.

## 1. Repo layout to create
```
tula-fleet/
  package.json  tsconfig.json  bunfig.toml  .github/workflows/ci.yml  scripts/no-hardcode.ts
  AGENTS.md  CLAUDE.md                       # generated, ≤40 lines
  engine/
    cli/fleet.ts                             # init | start | stop | sync | doctor | approve | reindex | backup | template import|export | config get|set|history|revert
    schema/{common,task,run,handoff,spend-request,approval,access-grant,event,scorecard,verdict,
            workflow,node-types,workflow-instance,team,connection,connector-manifest,template,config-version,
            company,department,role,agent,providers,routing,policy,limits,schedule}.ts
    schema/json/*.schema.json                # exported from Zod, CI diff-checked
    lib/{store,lock,chain,paths,ids,redact,crypto,jsonlogic}.ts
    config/{registry.ts,service.ts,validate.ts,risk.ts,watch.ts,git.ts}        # config-as-data (P1-C)
    fleetd/{server.ts,modules.ts,auth,ws,kill,lease,tasks,approvals,policy,dispatcher,router,brief,handoff,
            metrics,brain,triggers,verify,audit}/
    workflow/{validate/,engine/,nodes/,sim/}                                  # P1-W1..W3
    connectors/{sdk/,registry.ts,builtin/{manual,brain,notify}/,linkedin/manifest.json,youtube/manifest.json}
    exec/publisherd/                          # Phase 1: manual-action relay + Infisical ref checker only
    gateway/{server.ts,tools/*.ts}
    adapters/{types.ts,claude-code/,fleet-loop/}
    hooks/{policy-check,event-log,ctx-report,session-start}.ts
    prompts/common.md                         # universal rules only; role prompts are DATA
    skills/<name>/SKILL.md                    # skills library; which roles use them is DATA
    templates/                                # DATA packages (no code)
      defaults-v1/  org-full-life/  roles-content/  roles-verification/  wf-learning-to-linkedin/  team-youtube-channel/
  ui/src/{api/,forms/,inbox/,kanban/,office/,workflow/{view,builder}/,org/,connections/,settings/,templates/,wizard/,history/}
  company.example/                            # = result of importing the starter templates with fake params
  tests/{unit,contract,e2e,fixtures}/
  docs/{SPEC.md,PHASE-1-PLAN.md}
$FLEET_HOME (default ~/.tula-fleet; a git repo for config history)
  company.json org/{departments,teams,roles,agents,schedules}/*.json org/{providers,routing,policy,limits,portfolio}.json
  workflows/<id>.json  workflows/instances/<id>/  connections/<id>.json  templates/installed/
  brain/ tasks/ runs/ approvals/ grants/ audit/ staging/ evals/ exec/ state/ host.json
```

## 2. Backlog (ordered)

Legend: **Wave** = slices that can be built at the same time in separate worktrees once the listed dependencies are merged (max 5 at once).

### Phase 0: Foundations and scaffold fixes
| ID | Slice | Size | Builder | Wave / after | v1.1 change |
|---|---|---|---|---|---|
| P0-1 | Repo hygiene + strict TS | S | Coder-mid | 0, **in progress** | **unaffected** |
| P0-2 | Schemas (Zod → JSON Schema), incl. workflow/team/connection/connector/template/config-version | **L** (was M) | Coder-deep | A, after P0-1 | **changed:** adds Workflow, node-type configs, WorkflowInstance, Team, Connection, ConnectorManifest, Template, ConfigVersion, and all config kinds (company, department, role, agent, providers, routing, policy, limits, schedule). Extends Task/Event. |
| P0-3 | Store, locks, hash chains | M | Coder-deep | A, after P0-1 | unaffected |
| P0-4 | Approvals rewrite (self-approval + early consume) | M | Coder-deep + judge | B, after P0-2, P0-3 | unaffected |
| P0-5 | Event/ctx race fix | S | Coder-mid | B, after P0-3 | unaffected |
| P0-6 | `$FLEET_HOME`, config **registry** loader, `fleet doctor`, age key | M | Coder-mid | B, after P0-2, P0-3 | **small change:** the loader is generic over registered config kinds and must boot an **empty company**. `$FLEET_HOME` is initialised as a git repo. The provider check uses `privateEligible` (owner-locked field) instead of an engine constant. |
| P0-7 | Template format + importer/exporter (CLI) + starter templates as data + generic agent generator + no-hardcode lint | **L** (was M) | Coder-mid | B, after P0-2, P0-3 | **changed:** no fixed org in code. Builds `template.json` format, `fleet template import --preview/--apply` (params, diff, conflicts, one commit) and `export` (strips secrets/handles/private data). Ships data for `defaults-v1`, `org-full-life`, `roles-content`, `roles-verification`, `team-youtube-channel`. The claude-code generator emits `.claude/agents` for whatever org exists. |

**P0-2 details.** Touches `engine/schema/*`, `schema:export`. Tests: ≥ 2 valid + ≥ 2 invalid fixtures per schema, workflow fixtures covering every node type, the export check. Accept: `bun run schema:export --check` passes, and section 3 below matches the export exactly (CI diff).

**P0-6 details.** Tests: boots with an empty `$FLEET_HOME` (no departments/teams/workflows) and `/health` is ok after P1-1; an invalid config file is rejected and the last-good version stays loaded; `privateEligible: true` on a non-Claude-Max, non-loopback provider loads only if an owner-confirmation record exists. Doctor checks as in v1.0.

**P0-7 details.** Touches `engine/cli/template.ts`, `engine/templates/**`, `engine/adapters/claude-code/generate.ts`, `scripts/no-hardcode.ts`. Tests: import into an empty home creates the full-life org; re-import shows "no changes"; a conflicting import shows conflicts and applies nothing until resolved; export → import round-trips with secrets/handles stripped; generator snapshot for two different orgs; the no-hardcode lint catches a planted template id in engine code. Accept: `fleet template import org-full-life defaults-v1 roles-content roles-verification --apply` in a fresh home → `fleet sync` → `.claude/agents/*.md` generated, `company.example` equals that result.

P0-1, P0-3, P0-4, P0-5: details unchanged from v1.0 (repo hygiene; atomic store/locks/chains; two-phase hash-bound approvals with self-approval test; append-only hooks with `agent_id` linking).

### Phase 1, milestone M1: generic engine runs the C15 slice as a workflow
| ID | Slice | Size | Builder | Wave / after |
|---|---|---|---|---|
| P1-1 | fleetd skeleton: Hono, owner auth + re-auth (PIN now, passkey later), WS bus, lease, kill switch | M | Coder-mid | C, after P0 |
| P1-8 | Brain service (intake, compile, search, read, lint) | M | Coder-mid | C, after P0 |
| P1-K1 | Connector SDK + registry + builtin `manual`/`brain`/`notify` + LinkedIn/YouTube manifests | M | Coder-mid | C, after P0-2 |
| P1-W1 | Workflow validator (graph, types, refs, scope, taint, gate rule, budget, risk classification) | L | Coder-deep + judge | C, after P0-2 (refs via a resolver interface) |
| P1-U0 | UI shell + API client + schema-driven form kit (@rjsf + custom widgets) | M | Coder-mid | C, after P0-2 |
| P1-C | Config service: validated writes, versions, git auto-commit, watcher (last-good), risk-widening hold + owner confirm, history/revert, REST `/api/config` | M | Coder-deep | D, after P1-1, P0-6 |
| P1-2 | MCP gateway core + skill tools + scope token | M | Coder-deep | D, after P1-1 |
| P1-4 | Tasks: store, state machine, tools, board API (Tasks carry `workflowInstanceId`/`nodeId`) | M | Coder-mid | D, after P1-1 |
| P1-7 | Metrics: OTLP receiver, scorecards, detectors, token cap | M | Coder-mid | D, after P1-1 |
| P1-T | Trigger service: schedule / manual / event / webhook → workflow instances (replaces P1-9) | M | Coder-mid | D, after P1-1 |
| P1-U1 | Approvals inbox (phone), incl. manual-action cards ("copy, post, paste URL") | M | Coder-mid | D, after P1-U0 |
| P1-U2 | Kanban | S | Coder-mid | D, after P1-U0 |
| P1-U3 | Simple pixel office (rooms/avatars generated from org data) | M | Coder-mid | D, after P1-U0 |
| P1-U4 | Workflow read-only view + run overlay (@xyflow/react) | M | Coder-mid | D, after P1-U0 |
| P1-3 | Policy: scopes, policy-check hook (fail closed), access request/grant/escalate (grant ≤ granter) | M | Coder-deep + judge | E, after P1-2, P1-4 |
| P1-5 | Dispatcher + router + brief + claude-code adapter + data-class routing (`privateEligible`, fail closed) | L | Coder-deep + judge | E, after P1-2, P1-4, P1-C |
| P1-K2 | Connections store + Infisical ref resolution (existence check by an execution-service identity; values never leave it) + health status | M | Coder-deep | E, after P1-K1, P1-C |
| P1-T2 | Template `wf-learning-to-linkedin` + its role prompts + skills (`verify`, `judge-rubric`, voice note), **data only** | S | Coder-mid | E, after P1-W1, P0-7 |
| P1-6 | Handoff contract + 35% handoff-and-restart | M | Coder-mid | F, after P1-5 |
| P1-W2 | Workflow engine core + node executors (agent, verify, judge, approval, action, branch, fanout/fanin, loop, wait, notify, set, subworkflow); idempotency, retries, resume, kill | L | Coder-deep + judge | F, after P1-W1, P1-4, P1-5, P1-K1 |
| P1-15 | Backup (restic) + restore test (config history included) | S | Coder-cheap | F, after P0-6 |
| P1-W3 | Simulator / dry-run (fixtures or recorded runs; actions sandboxed; gateway rejects real actions for `sim`) | M | Coder-mid | G, after P1-W2 |
| P1-14 | Wire UI to the live API + ntfy push | S | Coder-mid | G, after P1-U1..U4, P1-W2 |
| P1-16 | Portability: fleet-loop adapter (local/OpenAI-compatible) + Codex probe + failover | M | Coder-mid | G, after P1-6 |
| P1-E1 | **M1 end-to-end** (below) + golden tasks | M | Coder-deep (integrator) | H, after all M1 slices |

### Phase 1, milestone M2: Tej builds it himself in the UI
| ID | Slice | Size | Builder | Wave / after |
|---|---|---|---|---|
| P1-U10 | Version history / diff / revert component (used by every editor) | S | Coder-mid | I, after P1-C, P1-U0 |
| P1-U5 | **Workflow builder:** palette (node types + connector actions), drag/drop, inspector forms from node schemas, live validation badges, simulate, run overlay, versions, save with risk-widening confirmation | L | Coder-mid (+ deep review) | I, after P1-U4, P1-W1, P1-W3, P1-C |
| P1-U6 | **Org editor:** departments, teams, roles (prompt, tools, scopes, tiers), agents (names, avatars), budgets, autonomy ≤ parent | M | Coder-mid | I, after P1-U0, P1-C |
| P1-U7 | **Connections manager + Create-team wizard** (connector picker, auth mode, manifest form, Infisical ref picker with exists ✓, posting mode, limits, ToS ack) | M | Coder-mid | I, after P1-U0, P1-K2 |
| P1-U8 | **Settings editors:** schedules, policy/thresholds/caps/autonomy, providers + routing + failover + private eligibility (owner-locked) | M | Coder-mid | I, after P1-U0, P1-C |
| P1-U9 | **Templates UI** (import preview/params/conflicts, export) + **first-run wizard** (empty home → guided forms; reuses the template importer; replaces CLI-only P1-17; CLI `--answers` mode kept) | M | Coder-mid | I, after P1-U0, P0-7, P1-C |
| P1-E2 | **M2 end-to-end** (below) | M | Coder-deep (integrator) | J, after all M2 slices |

### Slice details (new or changed)

**P1-C Config service.** `PUT /api/config/:kind/:id {expectedVersion, data}` → Zod + semantic validator per kind (workflows → P1-W1) → `risk.ts` classifies the diff (SPEC 26.3) → widening changes are stored as `pending_confirmation` and become active only after `POST /api/config/confirm {changeId}` with owner re-auth → `store.write` → git commit → `ConfigVersion` + audit → WS `config.changed`. A watcher handles hand edits (invalid → rejected, last-good stays active; widening → held for confirmation). History/revert endpoints. Hot vs next-run effects per SPEC 26.5 (exposed as `effective: 'now' | 'next_run'` in the response). Tests: optimistic-concurrency conflict, invalid write rejected, widening held until confirmed, revert creates a new version, hand-edit path, tightening applies immediately (running Run stopped at its next tool call). Accept: editing a team budget in the UI shows up as a git commit with a diff and an audit entry.

**P1-K1 Connector SDK.** The manifest loader validates against `connector-manifest.schema.json`. The registry lists builtin connectors only (third-party loading is disabled in Phase 1 and the code path throws). Module interface `{ manifest, actions, health?, oauth? }`. The `manual` connector implements `post.manual` / `upload.manual` / `task.manual`, producing a manual-action card and completing when Tej submits a URL or confirmation. `brain` and `notify` connectors. LinkedIn/YouTube manifests with `status: planned` actions (selectable in manual mode only). Tests: manifest validation, the registry refuses non-builtin, manual action lifecycle, a planned action can't execute in api/browser mode. Accept: `GET /api/connectors` returns 5 manifests, and the UI form kit renders each `configSchema`.

**P1-K2 Connections.** CRUD via the config service (kind `connection`). Exactly one team per connection, auth modes `api`/`browser`/`manual` (only `manual` executes in Phase 1). API refs are checked by `exec/publisherd ref-check` using its own Infisical Cloud machine identity: it calls the Infisical API to confirm each secret key exists and returns `exists | missing | forbidden` + last-rotated date. **No value is read into fleetd, logged or returned.** Health status field + scheduled health probe hook (no-op for manual). Tests: a connection without a team is rejected; switching auth mode is risk-widening; the ref-check response never contains a value (contract test with a fake Infisical server); fleetd process memory/log grep finds no fake secret value. Accept: creating "LinkedIn: personal" (manual) and "YouTube: main channel" (manual, with planned api refs showing exists ✓/missing) works end-to-end via the API.

**P1-W1 Workflow validator.** Implements SPEC 27.3 items 1-9 as pure functions over `(workflow, configSnapshot)`. Returns `{ ok, errors[{ nodeId?, edgeId?, code, message }], warnings[], risk: { widening: boolean, reasons[] }, estimate: { usdP50, usdMax } }`. JSON Logic expressions are type-checked against the bound schemas where possible. Tests (table-driven fixtures): an unreachable node; a cycle without a loop; a binding to a missing output field; a role lacking a needed tool; `tierOverride` above the role max; private taint flowing into a non-eligible role; a `write_external` path missing approval (rejected) vs a connection with auto mode (accepted with a widening flag); a loop without `maxIterations`; a sub-workflow widening scope; a budget overflow. Accept: 100% of fixtures produce the expected codes, and `wf-learning-to-linkedin` validates clean.

**P1-T Trigger service.** Schedules (cron, tz, catch-up `once|skip|all`, pause/postpone/skip), manual (UI button / CLI), event (fleetd event bus filter, e.g. `brain.intake` with `source=owner`), webhook (`POST /hooks/:workflowId/:triggerId`, HMAC with a secret ref, Tailscale/localhost only). Each fire creates a WorkflowInstance with the pinned active version. Tests: laptop asleep for 2 days → one catch-up, an event filter match, a webhook with a bad HMAC rejected, a paused trigger doesn't fire. Accept: a schedule and an event trigger both start instances in CI with a fake clock.

**P1-W2 Workflow engine.** Instance state machine (`running | waiting | paused_killed | failed | done | cancelled`), node executors per SPEC 27.2. `agent`/`verify`/`judge` create Tasks (single owner = node's role agent within the team, `workflowInstanceId`, `nodeId`, output validated against `outputSchema` via `task.output`). `approval` creates an Approval bound to the payload hash. `action` calls the connector through publisherd with an approval token the engine can't forge (signed by the policy engine after re-checks). Idempotency keys, retries, `onError` edges, resume after restart, kill-switch pause, version pinning. Tests: crash between action dispatch and completion → no double execution; fan-out 3 / fan-in all; a loop stops at `maxIterations`; a kill mid-instance → `paused_killed` → resume continues; an action without a valid approval token is refused by publisherd; a running instance keeps v1 after v2 is saved. Accept: a fixture workflow with every node type completes, and the event stream renders in the P1-U4 overlay.

**P1-W3 Simulator.** `POST /api/workflows/:id/simulate {fixture | fromInstanceId, autoApprove?}` runs with `sim: true`. Agent nodes return fixture/recorded outputs, approvals are auto-answered or prompted, actions write to `runs/sim/<id>/actions.log`, and **gateway + publisherd reject any real action for sim instances** (contract test). Accept: simulating `wf-learning-to-linkedin` from a recorded run reproduces the same node path and shows the cost estimate, with no Tasks visible on the real board (filtered `sim`).

**P1-T2 Template `wf-learning-to-linkedin`.** The SPEC 27.8 graph as `workflow.json` + params (`connectionId`, `teamId`, `schedule`, `voiceNote`). Role templates (Curator, Writer, Editor, Verifier, Judge, LinkedIn Manager as coordinator) live in `roles-content` / `roles-verification` with prompts, minimal tools, scopes and default tiers. Skills: `verify`, `judge-rubric`, voice note `brain/wiki/brand/voice.md` template. Tests: validates clean (P1-W1), simulates clean (after P1-W3), the no-hardcode lint confirms nothing references this template from engine code. Accept: imported via `fleet template import wf-learning-to-linkedin --param connectionId=...`.

**P1-U0 UI shell + form kit.** Vite + React + Tailwind + TanStack Query + WS client. A typed API client generated from the JSON Schemas. A form kit on `@rjsf/core` with custom widgets: role/agent/team/connection pickers, Infisical ref picker (shows `exists ✓` from P1-K2, never values), cron builder, tier select limited by role max, JSON Logic editor, scope editor (globs/prefixes). Owner re-auth modal for risk-widening saves. Tests: every config schema renders a form without errors (generated test per schema), the re-auth modal blocks the save until confirmed. Accept: storybook-style page renders forms for all config kinds.

**P1-U1..U3** as v1.0 P1-11..13, with two changes: the office and kanban are generated entirely from org data (no fixed rooms), and the inbox shows **manual-action cards** for `manual` connections (copy text / open platform / paste posted URL).

**P1-U4 Workflow view.** @xyflow/react read-only render of any workflow version, node status overlay from instance events (colors, attempts, duration, cost), and an instance picker. Accept: the M1 instance renders live while running.

**P1-U5 Workflow builder.** Editing on top of P1-U4: palette (node types + connector actions from manifests, planned actions disabled unless the connection is manual), drag/drop, edge drawing with port typing, inspector (P1-U0 forms from node-type config schemas), live validation via `POST /api/workflows/:id/validate` (debounced) with badges, Simulate button (P1-W3), version history/diff (P1-U10), Save (risk-widening → re-auth modal showing the diff + reasons). Tests: create a 3-node workflow from scratch and save; removing an approval gate before an external action is blocked by validation; adding a `write_external` action triggers re-auth; undo/redo. Accept: Tej duplicates `wf-learning-to-linkedin`, adds a second Editor pass, simulates and saves in < 5 minutes.

**P1-U6 Org editor.** Tree + forms for departments, teams, roles, agents (display names, `namedAfterRealPerson`, avatar), tiers, native tools, scopes, budgets, autonomy (UI and server cap it at the parent level). Retiring a role that's referenced by active workflows shows the references and blocks the retire. Accept: rename every agent, add a "Shorts" team under Content, and the office shows the new desks after save.

**P1-U7 Connections + Create-team wizard.** SPEC 28.2 steps. Browser auth mode is selectable but shows "available in Phase 4". API refs are validated live. Accept: Tej creates "YouTube: Main channel" (team + manager + 2 members + manual connection + workflows from a template) in one wizard run, confirmed as one change set.

**P1-U8 Settings editors.** Schedule editor (also edits trigger nodes' schedules, kept in sync by the config service), policy/threshold/caps/autonomy editor (widening marked), provider/routing editor (detected providers from doctor, tier maps, failover chains, `privateEligible` owner-locked with a C13 warning, prices).

**P1-U9 Templates + first-run wizard.** The import screen (pick, params form, diff preview, conflict resolution, apply) and the export screen (selection, stripped fields shown). The first-run wizard on an empty home runs: company basics → keys/recovery → providers (doctor) → import starter templates (each optional) → accounts/connections (manual by default) → goals/portfolio → done.

**P1-E1 M1 end-to-end (exit check M1).**
1. Fresh home → `fleet template import defaults-v1 org-full-life roles-content roles-verification wf-learning-to-linkedin` → engine code contains no reference to any of them (lint).
2. A learning dropped at 21:00 starts a `wf-learning-to-linkedin` instance (event trigger). A verified draft is waiting at the approval node by 08:35 the next weekday.
3. Tej approves on his phone, gets the manual-action card, copies the text, posts, pastes the URL, and the instance ends `done` with evidence.
4. The builder view shows the instance path, and scorecards show cost per accepted post.
5. Plus the v1.0 checks: STOP within 2 s; a Health-team task with Claude Max unavailable pauses; self-approval is denied; access request → grant → expiry; resume on a second provider; backup restore test.

**P1-E2 M2 end-to-end (exit check M2).** Using only the UI on a fresh home: the wizard sets up the company → the Create-team wizard builds a YouTube team with a manual connection → the builder clones the LinkedIn workflow for a second LinkedIn connection, adds a node, simulates and saves (re-auth shown because the action changed) → schedules/policy edited → export a template → import it into a second fresh home and it validates and simulates identically.

## 3. Data contracts (JSON Schema 2020-12; Zod in `engine/schema/` is canonical, these are the exported shapes)

### 3.1 Core contracts (v1.0, extended in v1.1)

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
    "departmentId": { "type": "string" }, "teamId": { "type": "string" },
    "workflowInstanceId": { "$ref": "common#/$defs/ulid" }, "nodeId": { "type": "string" }, "sim": { "type": "boolean" },
    "parentTaskId": { "$ref": "common#/$defs/ulid" },
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
                       "detector.alert", "schedule.fired", "kill.on", "kill.off", "provider.degraded", "provider.recovered",
                       "workflow.instance.start", "workflow.node.state", "workflow.instance.end", "config.changed", "config.pending_confirmation",
                       "connection.health", "manual_action.requested", "manual_action.completed"] },
    "source": { "enum": ["hook", "adapter", "otel", "fleetd", "gateway", "ui"] },
    "runId": { "$ref": "common#/$defs/ulid" }, "taskId": { "$ref": "common#/$defs/ulid" },
    "workflowInstanceId": { "$ref": "common#/$defs/ulid" }, "nodeId": { "type": "string" }, "sim": { "type": "boolean" },
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

### 3.2 New in v1.1: configuration-as-data contracts

**Workflow** (`workflow.schema.json`; one file per workflow version in `$FLEET_HOME/workflows/`)
```json
{
  "$id": "workflow", "type": "object", "additionalProperties": false,
  "required": ["id", "version", "name", "status", "nodes", "edges"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,63}$" },
    "version": { "type": "integer", "minimum": 1 },
    "name": { "type": "string", "maxLength": 80 }, "description": { "type": "string", "maxLength": 500 },
    "teamId": { "type": "string" },
    "params": { "type": "object", "description": "JSON Schema for instance/template params" },
    "status": { "enum": ["draft", "active", "archived", "pending_confirmation"] },
    "nodes": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/node" } },
    "edges": { "type": "array", "items": { "$ref": "#/$defs/edge" } },
    "limits": { "type": "object", "properties": { "maxUsdPerInstance": { "type": "number", "minimum": 0 }, "maxConcurrentInstances": { "type": "integer", "minimum": 1 } } },
    "createdBy": { "type": "string" }, "updatedAt": { "$ref": "common#/$defs/ts" }
  },
  "$defs": {
    "nodeType": { "enum": ["trigger.schedule", "trigger.manual", "trigger.event", "trigger.webhook", "agent", "verify", "judge", "approval", "action",
                           "branch", "fanout", "fanin", "loop", "wait", "notify", "set", "subworkflow"] },
    "binding": {
      "oneOf": [
        { "type": "object", "additionalProperties": false, "required": ["from"], "properties": { "from": { "type": "string", "pattern": "^(trigger|params|nodes\\.[a-z0-9_-]+\\.output)(\\.[A-Za-z0-9_]+|\\[[0-9]+\\])*$" } } },
        { "type": "object", "additionalProperties": false, "required": ["value"], "properties": { "value": {} } }
      ]
    },
    "node": {
      "type": "object", "additionalProperties": false, "required": ["id", "type", "config"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9_-]{1,40}$" },
        "type": { "$ref": "#/$defs/nodeType" },
        "label": { "type": "string", "maxLength": 60 },
        "position": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } } },
        "config": { "type": "object", "description": "validated against node-types#/$defs/<type>" },
        "inputs": { "type": "object", "additionalProperties": { "$ref": "#/$defs/binding" } },
        "outputSchema": { "type": "object", "description": "JSON Schema of this node's output" },
        "retry": { "type": "object", "properties": { "max": { "type": "integer", "minimum": 0, "maximum": 5 }, "backoffSec": { "type": "integer", "minimum": 1 } } },
        "onError": { "enum": ["fail", "edge"] },
        "maxUsd": { "type": "number", "minimum": 0 }
      }
    },
    "edge": {
      "type": "object", "additionalProperties": false, "required": ["id", "from", "to"],
      "properties": {
        "id": { "type": "string" }, "from": { "type": "string" }, "to": { "type": "string" },
        "port": { "enum": ["default", "true", "false", "error", "each", "done"] }
      }
    }
  }
}
```

**Node-type configs** (`node-types.schema.json`; the validator applies `$defs[node.type]` to `node.config`)
```json
{
  "$id": "node-types",
  "$defs": {
    "jsonLogic": { "type": ["object", "boolean", "number", "string", "null"] },
    "trigger.schedule": { "type": "object", "required": ["cron", "tz"], "properties": { "cron": { "type": "string" }, "tz": { "type": "string" }, "catchUp": { "enum": ["once", "skip", "all"], "default": "once" } } },
    "trigger.manual": { "type": "object", "properties": { "inputSchema": { "type": "object" } } },
    "trigger.event": { "type": "object", "required": ["eventType"], "properties": { "eventType": { "type": "string" }, "filter": { "$ref": "#/$defs/jsonLogic" } } },
    "trigger.webhook": { "type": "object", "required": ["hmacSecretRef"], "properties": { "hmacSecretRef": { "type": "string" }, "inputSchema": { "type": "object" } } },
    "agent": {
      "type": "object", "required": ["roleId", "briefTemplate", "acceptance", "doneCondition"],
      "properties": {
        "roleId": { "type": "string" }, "agentId": { "type": "string" },
        "tierOverride": { "$ref": "common#/$defs/tier" },
        "briefTemplate": { "type": "string", "maxLength": 4000, "description": "may reference {{inputs.x}}; contents of files are never inlined, only paths" },
        "acceptance": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "doneCondition": { "$ref": "common#/$defs/doneCondition" },
        "skills": { "type": "array", "items": { "type": "string" } },
        "narrowScope": { "$ref": "common#/$defs/scope", "description": "intersected with the role scope; can only narrow" }
      }
    },
    "verify": { "type": "object", "required": ["roleId", "proposalFrom"], "properties": { "roleId": { "type": "string" }, "proposalFrom": { "type": "string" }, "rubric": { "type": "string" }, "hiddenTestsRef": { "type": "string" } } },
    "judge": { "type": "object", "required": ["roleId", "rubric"], "properties": { "roleId": { "type": "string" }, "rubric": { "type": "string" }, "familyPolicy": { "enum": ["other_than_implementer", "any"], "default": "other_than_implementer" }, "onUnavailable": { "enum": ["skip_weak", "pause"], "default": "skip_weak" } } },
    "approval": { "type": "object", "required": ["approver", "payloadFrom"], "properties": { "approver": { "type": "string", "description": "'owner' or a roleId" }, "payloadFrom": { "type": "string" }, "expiresHours": { "type": "integer", "minimum": 1, "default": 72 }, "allowEdit": { "type": "boolean", "default": true } } },
    "action": { "type": "object", "required": ["connectionId", "actionId"], "properties": { "connectionId": { "type": "string" }, "actionId": { "type": "string" }, "approvalFrom": { "type": "string", "description": "node id of the gating approval" } } },
    "branch": { "type": "object", "required": ["condition"], "properties": { "condition": { "$ref": "#/$defs/jsonLogic" } } },
    "fanout": { "type": "object", "properties": { "over": { "type": "string" }, "branches": { "type": "integer", "minimum": 2, "maximum": 10 }, "maxParallel": { "type": "integer", "minimum": 1, "default": 3 } } },
    "fanin": { "type": "object", "required": ["mode"], "properties": { "mode": { "enum": ["all", "any", "n_of"] }, "n": { "type": "integer", "minimum": 1 } } },
    "loop": { "type": "object", "required": ["maxIterations", "maxUsd"], "properties": { "forEach": { "type": "string" }, "until": { "$ref": "#/$defs/jsonLogic" }, "maxIterations": { "type": "integer", "minimum": 1, "maximum": 20 }, "maxUsd": { "type": "number", "minimum": 0 } } },
    "wait": { "type": "object", "properties": { "durationSec": { "type": "integer", "minimum": 1 }, "untilCron": { "type": "string" }, "untilEvent": { "type": "string" }, "timeoutSec": { "type": "integer", "minimum": 1 } } },
    "notify": { "type": "object", "required": ["message"], "properties": { "message": { "type": "string", "maxLength": 300 }, "priority": { "enum": ["low", "default", "high"] } } },
    "set": { "type": "object", "required": ["mapping"], "properties": { "mapping": { "type": "object", "additionalProperties": { "$ref": "#/$defs/jsonLogic" } } } },
    "subworkflow": { "type": "object", "required": ["workflowId", "version"], "properties": { "workflowId": { "type": "string" }, "version": { "type": "integer", "minimum": 1 } } }
  }
}
```

**WorkflowInstance**
```json
{
  "$id": "workflow-instance", "type": "object", "additionalProperties": false,
  "required": ["id", "workflowId", "workflowVersion", "status", "trigger", "nodeStates", "sim", "startedAt"],
  "properties": {
    "id": { "$ref": "common#/$defs/ulid" }, "workflowId": { "type": "string" }, "workflowVersion": { "type": "integer" },
    "status": { "enum": ["running", "waiting", "paused_killed", "failed", "done", "cancelled"] },
    "trigger": { "type": "object", "required": ["type"], "properties": { "type": { "type": "string" }, "payload": { "type": "object" } } },
    "params": { "type": "object" },
    "nodeStates": { "type": "object", "additionalProperties": {
      "type": "object", "required": ["status"],
      "properties": {
        "status": { "enum": ["pending", "running", "waiting", "done", "failed", "skipped"] },
        "attempts": { "type": "integer" }, "iteration": { "type": "integer" },
        "idempotencyKey": { "type": "string" }, "taskId": { "$ref": "common#/$defs/ulid" }, "approvalId": { "$ref": "common#/$defs/ulid" },
        "output": {}, "costUsd": { "type": "number" }, "startedAt": { "$ref": "common#/$defs/ts" }, "endedAt": { "$ref": "common#/$defs/ts" }
      } } },
    "sim": { "type": "boolean" }, "costUsd": { "type": "number" },
    "startedAt": { "$ref": "common#/$defs/ts" }, "endedAt": { "$ref": "common#/$defs/ts" }
  }
}
```

**Team**
```json
{
  "$id": "team", "type": "object", "additionalProperties": false,
  "required": ["id", "departmentId", "name", "managerAgentId", "memberAgentIds", "status"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,63}$" }, "departmentId": { "type": "string" },
    "name": { "type": "string", "maxLength": 60 }, "purpose": { "type": "string", "maxLength": 300 },
    "managerAgentId": { "type": "string" }, "memberAgentIds": { "type": "array", "items": { "type": "string" } },
    "connectionIds": { "type": "array", "items": { "type": "string" } }, "workflowIds": { "type": "array", "items": { "type": "string" } },
    "goalIds": { "type": "array", "items": { "type": "string" } },
    "envelopeId": { "type": "string" },
    "autonomy": { "enum": ["L0", "L1", "L2", "L3"], "description": "capped at the department level by the config service" },
    "dataClass": { "$ref": "common#/$defs/dataClass" },
    "status": { "enum": ["active", "paused", "dormant", "retired"] },
    "fromTemplate": { "type": "string" }
  }
}
```

**Connection**
```json
{
  "$id": "connection", "type": "object", "additionalProperties": false,
  "required": ["id", "teamId", "connectorId", "connectorVersion", "account", "auth", "posting", "status"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,63}$" }, "teamId": { "type": "string" },
    "connectorId": { "type": "string" }, "connectorVersion": { "type": "string" },
    "account": { "type": "object", "required": ["displayName", "owner"], "properties": {
      "displayName": { "type": "string" }, "handle": { "type": "string" }, "url": { "type": "string" }, "owner": { "enum": ["llc", "personal"] } } },
    "auth": { "type": "object", "required": ["mode"], "properties": {
      "mode": { "enum": ["api", "browser", "manual"] },
      "secretRefs": { "type": "array", "items": { "type": "object", "required": ["field", "project", "environment", "path", "key"], "properties": {
        "field": { "type": "string" }, "project": { "type": "string" }, "environment": { "type": "string" }, "path": { "type": "string" }, "key": { "type": "string" },
        "check": { "enum": ["unchecked", "exists", "missing", "forbidden"] }, "lastRotatedAt": { "$ref": "common#/$defs/ts" } } } },
      "identity": { "enum": ["publisherd", "paymentd"], "description": "execution service whose Infisical identity reads the refs" },
      "profileId": { "type": "string", "description": "browser mode: encrypted profile owned by fleet-pub; one per connection" } } },
    "posting": { "type": "object", "required": ["mode", "dailyLimit"], "properties": {
      "mode": { "enum": ["manual", "approve_then_auto", "auto_when_unavailable", "auto"] },
      "dailyLimit": { "type": "integer", "minimum": 0 }, "unavailableAfterHours": { "type": "integer", "minimum": 1 },
      "quietHours": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" }, "tz": { "type": "string" } } } } },
    "config": { "type": "object", "description": "validated against the connector manifest configSchema" },
    "sharedWithTeams": { "type": "array", "items": { "type": "string" } },
    "health": { "type": "object", "properties": { "status": { "enum": ["ok", "needs_login", "rate_limited", "error", "unknown"] }, "checkedAt": { "$ref": "common#/$defs/ts" }, "detail": { "type": "string", "maxLength": 200 } } },
    "tosAcknowledgedAt": { "$ref": "common#/$defs/ts" },
    "status": { "enum": ["active", "disabled", "pending_confirmation"] }
  }
}
```

**ConnectorManifest**
```json
{
  "$id": "connector-manifest", "type": "object", "additionalProperties": false,
  "required": ["id", "version", "platform", "authModes", "configSchema", "actions", "tosRisk", "trust"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,40}$" }, "version": { "type": "string" },
    "platform": { "type": "string" }, "description": { "type": "string", "maxLength": 300 },
    "authModes": { "type": "array", "minItems": 1, "items": { "enum": ["api", "browser", "manual"] } },
    "configSchema": { "type": "object" },
    "requiredSecrets": { "type": "object", "description": "per auth mode: list of secret field names", "additionalProperties": { "type": "array", "items": { "type": "string" } } },
    "actions": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["id", "title", "effect", "authModes", "inputSchema", "outputSchema", "status"], "properties": {
      "id": { "type": "string" }, "title": { "type": "string" },
      "effect": { "enum": ["read", "write_internal", "write_external"] },
      "authModes": { "type": "array", "items": { "enum": ["api", "browser", "manual"] } },
      "inputSchema": { "type": "object" }, "outputSchema": { "type": "object" },
      "rateLimit": { "type": "object", "properties": { "perHour": { "type": "integer" }, "perDay": { "type": "integer" } } },
      "status": { "enum": ["available", "planned"] } } } },
    "healthCheck": { "type": "object", "properties": { "everyMin": { "type": "integer" }, "kind": { "enum": ["api_ping", "browser_logged_in", "none"] } } },
    "tosRisk": { "type": "object", "additionalProperties": { "enum": ["low", "medium", "high"] }, "description": "per auth mode" },
    "netDomains": { "type": "array", "items": { "type": "string" } },
    "trust": { "enum": ["builtin", "signed", "unsigned"] },
    "signature": { "type": "string" }, "contentHash": { "$ref": "common#/$defs/sha256" }
  }
}
```

Example: the shipped `youtube` manifest (abridged), which shows the shape the UI renders from:
```json
{
  "id": "youtube", "version": "0.1.0", "platform": "YouTube", "description": "One YouTube channel per connection",
  "authModes": ["api", "browser", "manual"],
  "configSchema": { "type": "object", "properties": { "channelId": { "type": "string" }, "defaultPrivacy": { "enum": ["private", "unlisted", "public"], "default": "private" } }, "required": ["channelId"] },
  "requiredSecrets": { "api": ["oauth_client_id", "oauth_client_secret", "refresh_token"], "browser": [], "manual": [] },
  "actions": [
    { "id": "video.upload", "title": "Upload video", "effect": "write_external", "authModes": ["api", "browser", "manual"],
      "inputSchema": { "type": "object", "required": ["fileRef", "title"], "properties": { "fileRef": { "type": "string" }, "title": { "type": "string", "maxLength": 100 }, "description": { "type": "string" }, "privacy": { "enum": ["private", "unlisted", "public"] } } },
      "outputSchema": { "type": "object", "properties": { "videoUrl": { "type": "string" } } }, "rateLimit": { "perDay": 3 }, "status": "planned" },
    { "id": "analytics.read", "title": "Read channel analytics", "effect": "read", "authModes": ["api"],
      "inputSchema": { "type": "object", "properties": { "days": { "type": "integer" } } }, "outputSchema": { "type": "object" }, "status": "planned" }
  ],
  "healthCheck": { "everyMin": 360, "kind": "api_ping" },
  "tosRisk": { "api": "low", "browser": "high", "manual": "low" },
  "netDomains": ["www.googleapis.com", "oauth2.googleapis.com", "studio.youtube.com", "accounts.google.com"],
  "trust": "builtin"
}
```

**Template manifest** (`template.json`)
```json
{
  "$id": "template", "type": "object", "additionalProperties": false,
  "required": ["id", "version", "kinds", "requires", "files"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{1,63}$" }, "version": { "type": "string" },
    "title": { "type": "string" }, "description": { "type": "string", "maxLength": 500 },
    "kinds": { "type": "array", "items": { "enum": ["department", "team", "role", "agent", "workflow", "schedule", "connection", "providers", "routing", "policy", "limits", "portfolio", "skill", "brain_note"] } },
    "requires": { "type": "object", "properties": { "schemaVersion": { "type": "string" }, "connectors": { "type": "array", "items": { "type": "string" } }, "templates": { "type": "array", "items": { "type": "string" } } } },
    "params": { "type": "object", "description": "JSON Schema for import params" },
    "files": { "type": "array", "items": { "type": "object", "required": ["kind", "path"], "properties": { "kind": { "type": "string" }, "path": { "type": "string" } } } },
    "riskWidening": { "type": "boolean", "description": "computed on import; informational in the file" }
  }
}
```

**ConfigVersion** (index of every config change; the git commit holds the content)
```json
{
  "$id": "config-version", "type": "object", "additionalProperties": false,
  "required": ["kind", "id", "version", "hash", "actor", "ts", "status", "riskWidening"],
  "properties": {
    "kind": { "type": "string" }, "id": { "type": "string" }, "version": { "type": "integer", "minimum": 1 },
    "hash": { "$ref": "common#/$defs/sha256" }, "commit": { "type": "string" },
    "actor": { "type": "string", "description": "'owner' | 'file' | 'template:<id>' | agentId (proposals only)" },
    "ts": { "$ref": "common#/$defs/ts" },
    "status": { "enum": ["active", "pending_confirmation", "rejected", "superseded"] },
    "riskWidening": { "type": "boolean" }, "reasons": { "type": "array", "items": { "type": "string" } },
    "effective": { "enum": ["now", "next_run"] }, "confirmedAt": { "$ref": "common#/$defs/ts" }
  }
}
```

## 4. Gateway MCP tools (Phase 1)

All tools take the caller identity from the Run's scope token (never from arguments). All return `{ ok: true, data }` or `{ ok: false, error: { code, message, hint?, want? } }` with `code ∈ denied_scope | needs_access | killed | invalid | not_found | conflict | budget_exceeded | private_provider_unavailable | rate_limited | sim_forbidden`. Every call is an Event, and mutating calls are audited. **Which roles get which tools is data** (`role.gatewayTools`). The "Who" column is the default in the `roles-*` templates.

| Tool | Who (template default) | Input | Output |
|---|---|---|---|
| `task.get` | all | `{ taskId }` | `Task` (log truncated to last 20 lines) |
| `task.list` | managers, CoS | `{ status?, goalId?, teamId?, ownerAgentId?, limit≤50 }` | `{ tasks: TaskSummary[] }` |
| `task.create` | managers, CoS, Intake Router | `{ title, projectId, goalId, ownerAgentId, taskType, acceptance[], doneCondition, priority?, risk?, dataClass?, inputs?[], deps?[], dueAt? }` | `{ taskId }` |
| `task.update` | task owner; its manager | `{ taskId, status?, note?(≤500), blockedReason?, inputs?[] }` | `{ task }` (illegal transition → `conflict`) |
| `task.output` | task owner (workflow nodes) | `{ taskId, output }` | `{ ok }` (validated against the node's `outputSchema` → `invalid` with schema errors) |
| `handoff.write` | the Run's agent | `Handoff` minus `runId/taskId/trust/writtenAt` | `{ path }` |
| `decision.log` | all | `{ what(≤200), why(≤400), alternatives?[], reversible }` | `{ seq }` |
| `evidence.attach` | all | `{ kind, path \| url, note? }` | `EvidenceRef` |
| `skill.index` / `skill.section` | all | `{ name }` / `{ name, section }` | `{ core, sections[] }` / `{ text, tokensEst }` |
| `brain.intake` | CoS, Intake Router | `{ text, source, url?, dataClass? }` | `{ path }` (emits `brain.intake` event → may trigger workflows) |
| `brain.search` / `brain.read` / `brain.write` | per role scope | as v1.0 | as v1.0 |
| `publish.stage` | Writer, Editor | `{ connectionId, text, variants?[], claims: { text, factPath }[], assets?[] }` | `{ stagedPath, contentHash }` (connection must belong to the Run's team) |
| `verify.submit` | Verifier, Judge | `{ taskId, proposalHash, role, pass, findings[], evidence[] }` | `{ submissionId }` |
| `verdict.issue` | coordinator role of the node | `{ taskId, proposalHash, decision, reasons[] }` | `Verdict` |
| `access.request` / `access.grant` | all / managers+ | as v1.0 | as v1.0 (grant ⊆ granter authority, else escalates) |
| `metrics.self` | all | `{}` | `{ ctxPct, tokensUsed, costUsd, runBudgetLeftUsd }` |
| `config.propose` (M2) | Directors, CoS | `{ kind, id, data, why }` | `{ proposalId }`. Creates an `org_change` Approval for Tej with the diff. Never activates anything. |

**Not agent tools:** saving config/workflows, connection auth, executing actions (the workflow engine → publisherd with signed approval tokens), browser control (`browser.*`, Phase 4). Deferred: `task.delegate`, `meeting.*` (Phase 2); `spend.*` (Phase 3).

**REST (Owner/UI only):** v1.0 routes, plus:
- `GET/PUT /api/config/:kind/:id`, `GET /api/config/:kind/:id/history`, `POST /api/config/:kind/:id/revert {version}`, `POST /api/config/confirm {changeId}` (re-auth)
- `POST /api/workflows/:id/validate`, `POST /api/workflows/:id/simulate`, `POST /api/workflows/:id/run {params}`, `GET /api/workflows/:id/instances`, `GET /api/instances/:id`, `POST /api/instances/:id/{cancel,resume,migrate}`
- `GET /api/connectors`, `POST /api/connections/:id/check-refs`, `POST /api/connections/:id/health`, `POST /api/manual-actions/:id/complete {url|note}`
- `POST /api/templates/import/preview`, `POST /api/templates/import/apply`, `POST /api/templates/export`
- `POST /api/auth/reauth`, `POST /hooks/:workflowId/:triggerId` (webhook triggers, HMAC)

## 5. Parallel build map
```
Wave 0  P0-1 (in progress)
Wave A  P0-2 · P0-3
Wave B  P0-4 · P0-5 · P0-6 · P0-7
Wave C  P1-1 · P1-8 · P1-K1 · P1-W1 · P1-U0                      (W1 builds against schema fixtures + a resolver interface)
Wave D  P1-C · P1-2 · P1-4 · P1-7 · P1-T   then   P1-U1 · P1-U2 · P1-U3 · P1-U4   (cap 5 at once; UI slices use mocks)
Wave E  P1-3 · P1-5 · P1-K2 · P1-T2
Wave F  P1-6 · P1-W2 · P1-15
Wave G  P1-W3 · P1-14 · P1-16
Wave H  P1-E1  → milestone M1 (C15 slice runs as a workflow template)
Wave I  P1-U10 → P1-U5 · P1-U6 · P1-U7 · P1-U8 · P1-U9
Wave J  P1-E2  → milestone M2 (Tej builds it himself)
```
**Critical path:** P0-1 → P0-2 → P1-W1 → (P1-1 → P1-2/P1-4 → P1-5) → P1-W2 → P1-W3 → P1-E1 → P1-U5 → P1-E2.
**Conflict notes:** `engine/workflow/validate` (P1-W1) and `engine/workflow/engine|nodes` (P1-W2) are separate dirs; P1-W2 imports the validator and never edits it. P1-U5 extends P1-U4's components through props and doesn't rewrite them. Schema changes after P0-2 go through the integrator.
**Estimated duration:** M1 ≈ 3 weeks, M2 ≈ +2 weeks (with 3-5 parallel worktrees).
