---
type: spec
version: 1.1
status: locked for Phase 0-1 (changes after this go through an ADR in brain/decisions/)
owner: Tej
updated: 2026-10-18
companion: docs/PHASE-1-PLAN.md
---
# Tula Fleet: Spec v1.1

## CHANGELOG
- **1.1 (2026-10-18):** **Nothing is hard-coded (C17).** The engine ships only generic mechanisms, schemas, node executors and connectors. Org, teams, workflows, schedules, connections, providers, budgets, thresholds, autonomy and prompts are versioned DATA in `$FLEET_HOME`, edited in the UI or as files, and importable/exportable. The full-life org (8.4), the LinkedIn flow (6.2) and the S-defaults (25) are now starter **templates**. New sections: 26 configuration as data, 27 workflow engine + visual builder, 28 teams, connections and the connector framework (API via Infisical refs / browser via an isolated Playwright profile / manual). Private-provider eligibility became an owner-locked setting instead of an engine constant (4.8). UI scope gains all editors (15).
- **1.0 (2026-10-18):** Round 2 answers locked (C9-C16). Full life org from day one (section 8.4). Private data is pinned to Claude Max + loopback-local models and fails closed (sections 4.8, 11.3). Paper budget numbers fixed. Autonomy defaults fixed. Scaffold bugs became Phase 0 tasks (section 21). Remaining open items became safe defaults that Tej can override (section 25). Renamed SPEC-DRAFT.md → SPEC.md. Phase 1 backlog moved to PHASE-1-PLAN.md.
- **0.2:** Round 1 answers (C1-C8). Goal portfolio, channel posting modes, Infisical secret broker, secure data handling, laptop→VPS runbook, Lauren Tan practices, verification pipeline, rule promotion.
- **0.1:** First draft. Hybrid architecture (fleetd + MCP gateway + adapters), domain model, flows, scaffold review.

Tula Fleet is an autonomous AI-agent company that runs Tej's work and life toward stated goals. Confirmed decisions are in section 0. Overridable defaults are in section 25. Remaining assumptions are in section 24.

---

## 0. Confirmed decisions (Rounds 1-2, from Tej)

| ID | Decision | Where it lands |
|---|---|---|
| C1 | **Money is paper only first.** The play-money ledger runs the full flow: the fleet proposes, Tej pays by hand. A real capped card comes only after a clean period. | section 7 |
| C2 | **Entity: Tula Solutions LLC** (separate account) for all spend and revenue. | section 7 |
| C3 | **Personal, relationship and health data:** local only, encrypted at rest, never on GitHub, sent only to model providers Tej approves. | section 11 |
| C4 | **Provider order:** Claude Max first, then ChatGPT/Codex if linked, then any other API credentials present. Ships with a default config mapping task type → tier → provider+model. Local/open models can be linked (Ollama, LM Studio, OpenRouter or any OpenAI-compatible endpoint). Failover order is configurable per tier and filtered by data class. | section 4.8 |
| C5 | **Hosting:** laptop now, VPS later for 24/7. Switching is config-only: no machine-specific paths, a portable encrypted data dir, the same bun entrypoint / container image. Data must be secure while running locally too. | sections 4.9, 11.8 |
| C6 | **Posting is a per-channel setting.** Modes run from manual approval to auto-post when Tej can't look, via official API or browser automation. Secrets come from **Infisical**: agents never see credentials, and the runtime fetches and injects them at execution time. ToS/ban risk is shown per mode, but it is Tej's call. | sections 6.2, 10.5, 11.4 |
| C7 | **All three 90-day goals run in parallel:** (G1) income via content/YouTube, (G2) ship and sell a Tula product, (G3) job + personal brand. Prioritisation is portfolio-style. | section 8 |
| C8 | **"Lauren Tann" is Lauren Tan (poteto).** Her agent-org practices were evaluated and the adopted ones folded in. | section 13 |
| C9 | **Infisical Cloud free tier now**, self-hosted on the VPS later. | section 11.4 |
| C10 | **Full life org from day one:** Chief of Staff, Content (LinkedIn + YouTube), Product (Tula), Career, Finance, Brain, Relationships, Personal, Health. Security is a shared function. Titles now; Tej renames agents later in the UI. Shipped as the importable template `org-full-life` (C17). | section 8.4 |
| C11 | **Autonomy defaults:** everything external needs Tej. Brain runs internal work alone (L2). Finance may approve paper spends ≤ $5. | sections 7.4, 9 |
| C12 | **Paper budget:** $100 start, 30% reserve, 40% of revenue reinvested, $10/day token cap. | section 7.2 |
| C13 | **Private data (Relationships, Personal, Health, people notes) goes only to Claude Max + local models.** Never OpenAI or any other API. The data-class router enforces it: the fail-closed *mechanism* is code, while provider eligibility is an owner-locked setting defaulting to exactly this (C17, section 4.8). Private departments **fail closed** (pause, never fall back). | sections 4.8, 6.5, 11.3 |
| C14 | **First interface:** phone-friendly approvals inbox + kanban + simple pixel office. The meeting/walking view grows from there. | section 15 |
| C15 | **First end-to-end slice:** learning → verified LinkedIn draft → Tej approves → Tej posts himself. | PHASE-1-PLAN.md |
| C17 | **Everything is configurable data, nothing hard-coded.** Tej builds his own teams and workflows in the UI (drag-and-drop). Code holds mechanisms and safety invariants only (section 26.2). | sections 26-28 |
| C18 | **Teams own connections.** A team (e.g. a YouTube team) binds to one or more external accounts. Each connection uses API (creds from Infisical), browser (Tej logs in, the agent drives it under policy) or manual mode. | section 28 |
| C19 | **Workflows are visual graphs** that compile to Tasks/Runs, so every governance rule still applies. | section 27 |
| C16 | **Accounts exist** for LinkedIn, YouTube, a domain registrar and hosting. Vendor/account details are collected in onboarding (Channels + Accounts step); nothing is assumed in code. | section 6.7 |

---

## 1. Vision and non-goals

### 1.1 Vision
- A **company** of agents works toward a written **Goal portfolio** (C7). The structure is the CEO seat (Tej), the Chief of Staff, Directors, Managers and Employees. Departments map to areas of life and are fully configurable.
- **Everything durable is a file the owner can read**, so any model or vendor can resume the work. Vendor sessions are disposable.
- **Governance lives outside the LLM.** Permissions, approvals, money caps, token caps, secrets, the kill switch and metrics are enforced by deterministic local services that every agent must go through. Prompts ask. Code enforces.
- **Credential boundaries are real process/OS boundaries, not role labels.** This avoids the shared-account/shared-browser flaw noted in section 13.
- **Work is verified, not trusted.** A fresh verifier, hidden tests where they pay off, a judge from a different model family, and evidence-bearing handoffs.
- **It compounds.** The brain (evidence-backed), scorecards, review-comment→rule promotion, and a Coach loop that can be reverted.
- **It's fun to watch.** A pixel-art office next to serious admin panels.
- **Anyone can clone it.** The engine is generic, user data lives in `$FLEET_HOME`, and a first-run wizard sets it up.
- **Tej designs the company himself.** Teams, workflows, connections, schedules, budgets and policies are built in the UI (drag-and-drop workflow canvas, editors, wizards) and stored as versioned files. Templates are starting points, not code (C17).

### 1.2 Non-goals (v1)
- Not SaaS or multi-tenant. One owner, one active host at a time, one company.
- No autonomous real-money trading/investing. Paper only (A14).
- Agents named after real people never speak, post or message *as* those people (S4).
- Not a general chat assistant. Every action ties to a Task, Schedule or Meeting.
- Not bookkeeping/tax software. The ledger is management accounting. The books of record are the LLC's bank account and accounting tool (C2).
- No model training/fine-tuning.
- The fleet never optimises for volume (e.g. "1,000 PRs/month"). The primary efficiency metric is **cost per accepted change** (section 14).

---

## 2. Glossary (ubiquitous language)

Code, files, UI and prompts all use these terms. New terms go into `brain/glossary.md` via the brain intake.

| Term | Meaning |
|---|---|
| **Owner** | Tej. Holds the CEO seat. The only one who can approve L3+ actions, change caps, link credentials, or lift the kill switch. |
| **Chief of Staff (CoS)** | The top agent under the Owner. Handles intake and routing: turns ideas, bugs, learnings and requests into Tasks for the right Department. It does not do the work itself. Chairs meetings and writes the daily digest. |
| **Company** | One instance: Goal portfolio, org, budget, brain. Lives in `$FLEET_HOME`. |
| **Goal / Key Result (KR)** | A north-star outcome with measurable KRs. Several Goals run at once inside a **Portfolio**. |
| **Portfolio** | The set of active Goals, each with a budget share, token share, WIP limit and floor. Reallocated weekly by measured ROI (section 8). |
| **Department** | A configurable unit with a Director, envelope, autonomy level, data class and tool policy. |
| **Role / Agent** | A Role is a job template. An Agent is a named instance in the org tree. The name is a display label only. |
| **Helper** | A short-lived sub-agent spawned inside an Employee's own Run (vendor-native nesting). Not in the org chart. |
| **Project** | A bounded effort that serves one KR, owned by one Manager. |
| **Task** | A unit of work with **exactly one owner Agent**, acceptance criteria, and a **done-condition**. |
| **Done-condition** | A machine-checkable completion test (command, test suite, file/schema check, or a verifier rubric). Required for any unattended or overnight Run. |
| **Brief** | Generated minimal input for a Run: task, acceptance, done-condition, file paths, skill sections, scopes, budget, data-class allowance. |
| **Run** | One execution of one Agent on one Brief on one provider/model. |
| **Handoff** | A required structured note at the end of every Run: **owner, inputs, done-condition, status vs that condition, evidence, decisions, next**. The only way state moves between Runs and providers. |
| **Decision log** | An append-only log per Run/Project of non-trivial choices made autonomously (what, why, alternatives, reversibility). |
| **Evidence** | An attachment proving a claim: test output, command log, commit SHA, screenshot/video of the running app, file:line, source URL. |
| **Proposal** | The artifact being judged: a commit SHA for code, or a content hash for posts and documents. |
| **Verifier** | A *fresh* Agent Run (new context, no implementer transcript) that tests a Proposal against acceptance + hidden tests and attaches evidence. |
| **Judge** | A grader from a **different model family** than the implementer. It scores the verifier's evidence against a rubric and never edits. |
| **Verdict** | The Coordinator's (Manager's) pass/fail on a specific Proposal hash. A changed Proposal needs a new Verdict. |
| **Hidden tests** | Acceptance tests written by a Test-author role and stored outside the implementer's read scope. |
| **Rule promotion** | Turning a review finding that keeps recurring into a deterministic check (lint rule, CI check, failing test, schema rule). |
| **Gate** | A deterministic check that must pass (e.g. merge gate = granted scope + passing Verdict + CI green). |
| **Tier** | `cheap` / `mid` / `deep`. Agents speak only in tiers. The provider map turns a tier into a model. |
| **Provider / Adapter** | A Provider is a model source (Claude Max via Claude Code, Codex, API key, local endpoint). An Adapter is the code that runs Runs on it. |
| **Model family** | A vendor lineage (Anthropic, OpenAI, Google, Meta-Llama, Qwen, Mistral...). Used for judge independence. |
| **fleetd** | The local daemon: state, scheduling, policy, MCP gateway, UI API, metrics. |
| **Gateway tools** | MCP tools exposed by fleetd. The only way agents change governed state. |
| **Secret broker** | The component inside the execution services (publisherd, paymentd, provider launcher) that fetches secrets from Infisical at execution time. Agents never call it directly. |
| **Execution service** | A separate process with its own OS user and Infisical identity that performs external actions (publisherd, paymentd). |
| **Channel** | Legacy name for a Connection's external destination (kept in v1.0 text). See Connection. |
| **Team** | A unit inside a Department: one Manager, member Agents (from Role templates), its Connections, Workflows, budget and an autonomy override (never above the Department's). |
| **Connection** | A binding of **one** external account/channel to **one** Team, with auth mode `api` / `browser` / `manual`, a posting mode, daily limits and quiet hours. |
| **Connector** | Platform support = manifest (capabilities/actions, auth modes, config schema, rate limits, ToS risk, required secret fields) + implementation module. Adding a platform means adding a connector. |
| **Workflow** | A versioned JSON graph of typed nodes (triggers, agent steps, verify, judge, approval gates, actions, branches, loops...). |
| **Workflow instance** | One execution of a pinned Workflow version. Its nodes compile to Tasks/Runs/Approvals/actions. |
| **Template** | An importable data package (org, teams, roles, workflows, schedules, defaults) with parameters. Never code. |
| **Mechanism vs value** | Code provides mechanisms and invariants (gates exist, scopes only narrow, audit, kill, fail-closed). Data provides values (who, what, when, how much). |
| **Scope / Access Request / Access Grant** | A Scope is a permission an agent holds (paths, tools, domains, USD, tokens). An Access Request asks for a missing Scope. An Access Grant is a narrow, time-boxed Scope. |
| **Approval** | A single-use, expiring decision bound to a Proposal/action hash. |
| **Spend Request / Ledger / Envelope / Experiment** | See section 7. |
| **Data class** | `public` / `internal` / `private` / `secret` (section 11.2). |
| **Autonomy level** | L0 to L4 per Department (section 9). |
| **Kill switch** | A global stop for tools, Runs, schedules and execution services. |
| **Brain** | An Obsidian-compatible markdown vault: raw intake, then a compiled wiki. |
| **Fact / Assumption / Pattern / Anti-pattern** | Note types. All except Assumption need `evidence:`. |
| **ADR / Council / Meeting / Schedule** | As in v0.1: decision note + Excalidraw; 4-5 perspective one-round advisors; structured multi-agent conversation; recurring trigger. |
| **Scorecard / Coach / Coaching Note / Golden task** | Per-Run metrics; the improvement agent; an injected, trialled note of at most 120 words; a fixed per-Role eval. |
| **`$FLEET_HOME`** | The portable data dir holding all company state. The only path the engine needs. |

---

## 3. Personas

1. **Tej (Owner/CEO).** Busy, often checks in from his phone. Dumps learnings and goals in natural language, approves in one tap, sees spend and progress per goal, holds meetings, and chooses per channel how much to automate.
2. **Cloner.** Forks the repo, runs the wizard, sees none of Tej's data. `bun install && bun fleet init` in under 10 minutes.
3. **Agents.** Need small Briefs, clear tools, fast actionable denials, an access-request path, and a clear done-condition.
4. **Named-after people (non-users).** Must never be impersonated or exposed (section 10.4).

---

## 4. System architecture

### 4.1 Recommendation: governance gateway + fleetd orchestrator + thin per-vendor adapters + isolated execution services

| Option | Pros | Cons |
|---|---|---|
| A. MCP gateway only | Works with any MCP CLI. Little code. | Native shell/file/web tools can bypass policy. No loop or context control. |
| B. Own orchestrator loop only | Total control. Truly neutral. | Rebuilds Claude Code/Codex. Weaker coding. Can't use subscription-only CLIs (Claude Max). |
| C. Adapter per vendor only | Native quality. | Governance duplicated per vendor. Vendors without hooks are ungoverned. |
| **D. Hybrid (chosen, D1)** | One policy engine. Best-in-class coding CLIs where present. Open models still work. Failover = launch on another adapter. | Two enforcement layers to keep consistent. Some features degrade off Claude Code (section 4.6). |

**D1 rule:** governed state is outside every agent's write scope and only changes via gateway tools. **External actions and secrets live in separate execution services under separate OS users** (section 11.4). Agents can request and stage. They can never execute externally.

### 4.2 Components

```
                 ┌────────────────────── Owner (browser / phone via Tailscale) ──────────────────────┐
                 │ Pixel office · Approvals · Kanban · Portfolio · Meetings · Finance · Metrics · Settings │
                 └───────────────────────────────▲───────────────┬────────────────────────────────────┘
                                          WS events│               │REST (owner session + passkey for L3+ ops)
┌─────────────────────────────────────────────────┴───────────────▼─────────────────────────────────────┐
│ fleetd  (OS user: fleet)   Bun + Hono · single active instance (lease)                               │
│  Scheduler · Dispatcher(router, briefs, failover) · Policy(scopes, approvals, autonomy, caps, kill)   │
│  Ledger · Portfolio allocator · Brain svc(index, search, lint, crypto) · Verification svc · Meetings  │
│  Metrics(OTLP receiver, scorecards, detectors) · Coach · Audit log                                     │
│  MCP gateway: task.* brain.* spend.* access.* publish.* handoff.* decision.* evidence.* skill.* ...   │
└───────┬──────────────────┬───────────────────┬───────────────────────┬──────────────────┬─────────────┘
        │spawn as          │spawn as           │spawn as               │unix socket +     │unix socket +
        │OS user fleet-agent (Phase 2+)        │                       │signed approval   │signed approval
┌───────▼──────┐  ┌────────▼───────┐  ┌────────▼─────────┐   ┌──────────▼─────────┐ ┌──────▼──────────┐
│claude-code   │  │codex adapter   │  │fleet-loop adapter│   │publisherd          │ │paymentd (Ph. 5) │
│adapter       │  │(codex exec)    │  │(OpenAI-compatible│   │OS user fleet-pub   │ │OS user fleet-pay│
│(claude -p)   │  │                │  │ APIs, Ollama,    │   │Infisical id: pub   │ │Infisical id: pay│
│              │  │                │  │ LM Studio, OR)   │   │API + browser exec  │ │issuer API, caps │
└──────────────┘  └────────────────┘  └──────────────────┘   └────────────────────┘ └─────────────────┘
                                   Infisical (Cloud now, self-hosted on VPS later; C9) ◄── machine identities per service
```

### 4.3 Data stores (all provider-neutral, all under `$FLEET_HOME`)

| Store | Format | Canonical? | Writer | Default class |
|---|---|---|---|---|
| `company.json`, `org/*.json` | JSON (Zod) | yes | fleetd (Owner/UI/wizard; Directors propose diffs) | internal |
| `brain/{raw,wiki,decisions,diagrams}/**.md` | Markdown + frontmatter | yes | `brain.*` tools; Owner | internal/public |
| `brain/private/**.md.age` | age-encrypted markdown | yes | Brain svc only | private |
| `tasks/*.md` | frontmatter + log | yes | fleetd | internal (private if flagged) |
| `ledger/ledger.jsonl` | hash-chained JSONL | yes | Ledger svc | internal |
| `approvals/`, `grants/`, `audit/` | hash-chained JSONL | yes | Policy / Audit | internal |
| `meetings/`, `runs/<id>/` | md + jsonl + evidence files | yes | fleetd / adapters | per Task class |
| `staging/**` | drafts | yes | agents (scoped write) | public-bound |
| `evals/{golden,hidden}/**` | tests/rubrics | yes | Test-author role; hidden/ unreadable by implementers | internal |
| `state/fleet.sqlite` | derived index | **no** (`fleet reindex`) | fleetd | mirrors sources, private never indexed in plaintext |
| `exec/` (publisherd/paymentd private dirs) | encrypted browser profiles, caps | yes | execution services only | secret |
| Generated vendor files (`.claude/agents`, `AGENTS.md`, `CLAUDE.md`, codex config) | generated | **no** (`fleet sync`) | generator | internal |

**D2: files are canonical, SQLite is a disposable index.** Every canonical write uses `store.write()` (atomic temp+rename, per-file lock, schema validation, audit entry for governed types).

### 4.4 Data flow (happy path)
1. A Trigger creates or updates a Task. The CoS routes intake to a Department and Goal.
2. The Dispatcher picks the next Task under the Portfolio's fair-share and WIP rules (section 8), runs the Router (task type → tier), and resolves the provider via failover + data-class filter (section 4.8).
3. `brief.ts` writes `runs/<id>/brief.md` + a signed, short-lived scope token.
4. The Adapter launches the Run (as `fleet-agent` OS user from Phase 2) with the role prompt, Brief, MCP gateway connection, native-tool allow-list and a git worktree.
5. Governed changes go via gateway tools. Native tool calls are checked by vendor hooks/sandbox where present.
6. Usage/events stream to fleetd and the UI animates.
7. The Run ends with `handoff.write` (schema-enforced). The Task moves to `verify` if it has a Proposal, otherwise to done/blocked.
8. The verification pipeline (section 6.8) issues a Verdict on the Proposal hash. Then any Approval/merge gate. Then the execution service if external.

### 4.5 Adapter interface
```ts
interface Adapter {
  id: 'claude-code' | 'codex' | 'fleet-loop' | string;
  capabilities(): { nativeSubagents; hooks; skills; autocompact; mcp; sandbox: 'os'|'none'; maxContext; family: ModelFamily };
  detect(): Promise<{ available: boolean; auth: 'subscription'|'api'|'local'|'none'; models: string[] }>; // used by wizard + failover
  generate(org, provider): GeneratedFile[];
  start(run: RunSpec): RunHandle;          // normalized events
  stop(runId, reason): Promise<void>;
  classifyError(e): 'rate_limit'|'credits_exhausted'|'overloaded'|'auth'|'context'|'tool'|'other';
}
```

### 4.6 What degrades off Claude Code, and how we compensate
| Feature | Codex CLI (A17) | fleet-loop | Compensation |
|---|---|---|---|
| PreToolUse hooks | not assumed | full control | Governed state and external actions are unreachable except via the gateway/execution services. Codex sandbox + approval policy + worktree confine native tools. |
| Nested subagents | not assumed | none | **D3: org delegation uses `task.delegate`** (new metered Run). Native nesting only for Helpers. |
| Skills | AGENTS.md only | none | Gateway `skill.index` / `skill.section`, the same everywhere. |
| Autocompact 35% | own, not configurable (assumed) | ours | **Restart instead of compacting**: at 30% finish the unit, at 35% force a handoff and start a fresh Run from Brief + Handoff. Claude Code keeps `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=35` as a backstop. |
| OTel metrics | JSON usage events (assumed) | API usage fields | Normalized `usage` event. Cost computed by fleetd from price tables. Subscription usage is tracked as quota units (C12). |
| Worktrees, maxTurns, per-agent tools | partial | ours | The Dispatcher creates worktrees. Role specifics go in role prompt + Brief. AGENTS.md/CLAUDE.md stay under 40 lines. |
| Code quality | comparable | lower for small models | Open models default to `cheap` and `open_ok` tasks (A16). |

### 4.7 Routing: default task-type → tier config (data in `org/routing.json`, from template `defaults-v1`, edited in the Routing editor)

| Task type | Tier | Notes |
|---|---|---|
| classify, tag, extract, dedupe, format, route-intake (first pass) | cheap | |
| summarize, digest, pre-read, brain compile (raw→wiki draft) | cheap | |
| draft post / script / email draft | mid | |
| code slice (implement), test-author, verifier | mid | verifier is a fresh Run |
| judge | mid on a **different family** | falls back to a same-family different model, flagged `judge_independence: weak` |
| meeting turn | mid | |
| CoS planning, finance audit above auto-limit, council chair, security review of external/irreversible actions, Coach | deep | |
| anything flagged `irreversible` or `external` (planning Run) | ≥ deep | Council if > $25 or > 1 day |

Escalation (kept from the scaffold router): risk high, more than 8 files, or a failed attempt each add 1 tier. Keyword router + `cheap` classifier fallback + Manager override with a logged reason.

### 4.8 Providers, defaults and failover (C4)

**Detection order** (wizard and `fleet doctor`; re-run on demand):
1. **Claude Max via Claude Code** (`claude` installed and logged in).
2. **ChatGPT/Codex** (`codex` installed and logged in).
3. **Any API credentials present in Infisical** (Anthropic, OpenAI, Google, OpenRouter, Groq, Together, Mistral... matched by known secret names). Each becomes a `fleet-loop` provider.
4. **Local/OpenAI-compatible endpoints**: probe Ollama (`:11434`), LM Studio (`:1234`), plus any custom `baseUrl` the Owner adds. Lists models via `/v1/models`.

`org/providers.json` (generated defaults, Owner-editable):
```json
{
  "providers": {
    "claude-max":   { "adapter": "claude-code", "family": "anthropic", "auth": "subscription",
                      "tiers": { "cheap": "haiku", "mid": "sonnet", "deep": "opus" }, "dataClasses": ["public","internal","private"] },
    "codex":        { "adapter": "codex", "family": "openai", "auth": "subscription",
                      "tiers": { "cheap": "<detected>", "mid": "<detected>", "deep": "<detected>" }, "dataClasses": ["public","internal"] },
    "openrouter":   { "adapter": "fleet-loop", "family": "mixed", "baseUrl": "https://openrouter.ai/api/v1", "secretRef": "providers/OPENROUTER_API_KEY",
                      "tiers": { "cheap": "<pick>", "mid": "<pick>" }, "dataClasses": ["public"] },
    "ollama":       { "adapter": "fleet-loop", "family": "<model family>", "baseUrl": "http://127.0.0.1:11434/v1",
                      "tiers": { "cheap": "<local model>" }, "dataClasses": ["public","internal","private"] },
    "lmstudio":     { "adapter": "fleet-loop", "baseUrl": "http://127.0.0.1:1234/v1", "tiers": {}, "dataClasses": ["public","internal","private"] }
  },
  "failover": {
    "deep":  ["claude-max", "codex", "@any-api", "PAUSE"],
    "mid":   ["claude-max", "codex", "@any-api", "@local", "PAUSE"],
    "cheap": ["claude-max", "@local", "codex", "@any-api"]
  },
  "classChains": { "private": ["claude-max", "@local", "PAUSE"] },
  "taskOverrides": { "judge": { "preferFamilyOtherThan": "$implementer" } },
  "prices": { "_": "per-model $/Mtok; subscription = quota units" }
}
```
- `@any-api` / `@local` expand to every detected provider of that kind, in a configured order.
- **Filters on every pick:** data class allowed (section 11.3), not degraded, token envelope available, family constraint (judge), `open_ok` for local/small models on code.
- **Private eligibility is an owner-locked setting (C13 + C17).** Each provider has `privateEligible: boolean`. The default (template `defaults-v1`) is true only for (a) the `claude-code` adapter authenticated by **subscription** (Claude Max) and (b) `fleet-loop` providers whose `baseUrl` resolves to loopback. Setting it true on any other provider is a **risk-widening change** (section 26.3): owner re-auth + typed confirmation + audited diff, and the UI warns that it breaks C13. Agents, workflows and template imports can never set it. The *mechanism* (fail closed, below) is code and can't be configured off.
- **Fail closed:** for any Brief containing `private` data, or any Run for a Department whose `dataClass` is `private` (Relationships, Personal, Health), the effective chain is `classChains.private` filtered by `privateEligible`. If nothing is available, the Task goes to `blocked: private_provider_unavailable` and the Department pauses. It **never** falls through to the tier chain. A contract test proves this for every configured provider.
- No model ID is hard-coded in engine code.

**Failover flow:** section 6.5.

### 4.9 Host portability (C5)
- **One root:** `$FLEET_HOME` (default `~/.tula-fleet`). Config contains only paths relative to it, plus `host.json` (bind address, Tailscale name, OS users), which is the *only* host-specific file. It is not copied by migration.
- **One entrypoint:** `bun engine/cli/fleet.ts start`. Same on laptop and VPS. Also a `Dockerfile` + `compose.yaml` (fleetd, publisherd, paymentd as separate containers with separate volumes, users and Infisical identities). The laptop can run either way. Default: native bun on laptop, compose on VPS.
- **Single active instance:** fleetd takes a lease (`state/lease.json` + Infisical/remote heartbeat when two hosts exist) so schedules never fire twice. The other host runs read-only UI or nothing.
- **Runbook:** section 11.8.

---

## 5. Domain model

Zod schemas in `engine/schema/`. Every entity has `id` (ULID), `createdAt`, `updatedAt`, `version`. Changes from v0.1 are marked ▲.

```ts
Company      { name; ownerName; legalEntity: 'Tula Solutions LLC'; currency; timezone; moneyMode: 'paper'|'card'; autonomyMax; killSwitch }
▲Portfolio   { goals: { goalId; budgetShare; tokenShare; floorShare; wipLimit: { projects; runningTasks } }[]; reallocateEvery: 'weekly'; maxShiftPerWeek: 0.10; lastReview }
Goal         { title; why; keyResults: { id; metric; target; current; source; due; valuePerUnitUsd? }[]; status }
Department   { id; name; directorAgentId; purpose; autonomy; envelopeId; tools; dataClass; goalIds[]; status; room }
Role         { id; title; level; dutiesPrompt; tier; nativeTools; gatewayTools; readScopes; writeScopes; skills; maxTurns; maxRunUsd;
               omitProjectInstructions; goldenTasks; ▲canBeVerifierFor?: string[] }
Agent        { id; displayName; roleId; parentAgentId; departmentId; projectId?; avatar; namedAfterRealPerson; status; coachingNoteIds }
Project      { id; name; departmentId; managerAgentId; goalId; keyResultId; experimentId?; status; acceptance; envelopeId? }
Task         { id; projectId; goalId; title; ▲ownerAgentId /* exactly one */; acceptance: string[]; ▲doneCondition: DoneCondition;
               status: 'backlog'|'ready'|'running'|'verify'|'blocked'|'awaiting_approval'|'done'|'cancelled';
               priority; deps; risk; flags: ('external'|'irreversible'|'open_ok'|'private'|'overnight'|'hidden_tests')[];
               estimateUsd?; attempts; runIds; parentTaskId?; ▲proposal?: { kind: 'commit'|'content'; hash } }
▲DoneCondition { kind: 'command'|'tests'|'schema'|'rubric'; spec: string; timeoutSec }
Run          { id; taskId; agentId; adapter; provider; family; model; tier; startedAt; endedAt; outcome; briefPath; handoffPath; decisionLogPath; scopeTokenId; worktree?; osUser }
▲Handoff     { runId; owner; inputs: string[]; doneCondition; status: 'met'|'not_met'|'partial'; evidence: EvidenceRef[];
               decisions: string[]; changed: { files; commit? }; next: string[]; unverified: string[]; trust: 'agent'|'auto' }
▲EvidenceRef { kind: 'test_output'|'command_log'|'commit'|'screenshot'|'video'|'file_line'|'url'|'metric'; path|ref; sha256 }
▲Verdict     { id; taskId; proposalHash; verifierRunId; judgeRunId?; judgeFamily?; independence: 'strong'|'weak'; hiddenTestsResult?;
               decision: 'pass'|'fail'; reasons; issuedBy /* coordinator agent */; issuedAt }
▲ReviewFinding { id; verdictId; ruleKey /* normalized category, e.g. 'missing-error-state' */; severity; file?; text }
▲Rule        { id; ruleKey; kind: 'lint'|'ci_check'|'test'|'schema'|'skill_section'|'coaching'; path; createdFrom: ReviewFinding[]; status: 'proposed'|'active'|'retired' }
Scorecard    { runId; tokensIn; tokensOut; cacheRead; costUsd; quotaUnits?; turns; wallMs; peakCtxPct; retries; gateDenials; accessRequests;
               reviewResult?; acceptanceMet; loopFlags; helperCount; ▲verdict?: 'pass'|'fail'; ▲reworkOf?: runId }
Meeting      { id; kind; agenda; attendees; chair; transcriptPath; minutes; costCapUsd; status }
Envelope     { id; ownerType: 'company'|'goal'|'department'|'experiment'|'reserve'|'tokens'; ownerId; periodicity; allocated; committed; spent }
LedgerEvent  { seq; prevHash; hash; ts; type; amount; currency; envelopeId; mode: 'paper'|'real'; ref; evidence; actor }
SpendRequest { id; requesterAgentId; goalId; envelopeId; amount; recurring?; vendor; item; why; expectedRoi; alternatives; status; financeVerdict?; approvalId?; expiresAt }
Revenue      { id; goalId; source; amount; period; evidence: 'bank'|'platform_report'|'invoice'; attachmentPath; verifiedBy }
Experiment   { id; goalId; hypothesis; envelopeId; stageBudgets; successMetric; checkpoints; killRule; status }
▲Channel     { id; platform: 'linkedin'|'youtube'|'x'|'blog'|'newsletter'|string; account; mode: 'manual'|'approve_then_auto'|'auto_when_unavailable'|'auto';
               method: 'copy'|'official_api'|'browser'; unavailableAfterHours?; dailyLimit; quietHours; tosRisk: 'low'|'medium'|'high'; secretRefs: string[]; status }
Skill, BrainNote { ...as v0.1; BrainNote.dataClass now includes 'secret' (forbidden in brain; lint error) }
CoachingNote { id; roleId; text; reason; trialRuns; baseline; result?; goldenPass; ▲preferredAlternative?: RuleId }
Schedule     { id; departmentId; goalId; cron; tz; creates; catchUp; status; postponeUntil; ▲doneCondition? (required if overnight) }
Approval     { id; actionHash; kind; summary; requestedBy; approverRequired; status; decidedBy; decidedAt; expiresAt; usesLeft: 1 }
AccessRequest / AccessGrant / Scope { as v0.1 }
▲AuditEvent  { seq; prevHash; hash; ts; actor; action; target; dataClass?; provider?; secretName?; outcome; reason? }
▲SecretRef   { name /* Infisical path */; service: 'publisherd'|'paymentd'|'launcher'; purpose; rotationDays }
▲▲Team       { id; departmentId; name; managerAgentId; memberAgentIds; connectionIds; workflowIds; envelopeId; autonomy /* ≤ department */; status }
▲▲Connection { id; teamId; connectorId; connectorVersion; account: { handle; displayName; owner: 'llc'|'personal' }; auth: { mode: 'api'|'browser'|'manual'; secretRefs?; profileId? };
               posting: { mode; dailyLimit; quietHours; unavailableAfterHours? }; config /* validated by connector manifest */; health; status }
▲▲ConnectorManifest { id; version; platform; capabilities; actions[{ id; effect: 'read'|'write_external'; inputSchema; outputSchema; authModes }]; authModes; configSchema;
               requiredSecrets; rateLimits; tosRisk; netDomains; trust: 'builtin'|'signed'|'unsigned' }
▲▲Workflow   { id; version; name; teamId?; params; nodes[]; edges[]; status: 'draft'|'active'|'archived'; createdBy; validatedAt }
▲▲WorkflowInstance { id; workflowId; workflowVersion /* pinned */; trigger; status; nodeStates; startedAt; endedAt; sim: boolean }
▲▲ConfigVersion { kind; id; version; hash; actor; ts; diffPath; riskWidening: boolean }
(Exact JSON Schemas: docs/PHASE-1-PLAN.md section 3. ▲ = new in v0.2, ▲▲ = new in v1.1.)
```

---

## 6. Key flows

### 6.1 Spend approval ($10 domain, paper mode, C1/C2)
1. An Eng Employee calls `spend.request({ amount: 10, vendor, item, why, expectedRoi, alternatives, goalId })`.
2. fleetd validates the request and checks kill switch, envelope (goal → department), daily cap, vendor deny-list and recurrence. **Any deterministic check failing auto-denies.**
3. The Finance Director (deep) gives a structured verdict. It can only tighten.
4. Threshold routing (section 7.4) sends it to Finance alone or to the Owner.
5. Approval (single-use, 72h). Ledger `commit` (mode `paper`).
6. **Execution (paper):** an Owner Task "Buy on LLC card" with a prefilled link. Tej buys it and attaches the receipt.
7. Ledger `spend` with receipt evidence. Over $25 gets a decision note.
8. **Graduation to real card** after the clean period (section 7.5).

### 6.2 "Here's what I learned" → post (per-channel mode, C6)
*Since v1.1 this flow is the workflow template `wf-learning-to-linkedin` (graph in section 27.8). The steps below describe what that template does. None of it is engine code.*
1. Tej tells the CoS (UI chat, CLI, or phone drop into `brain/raw/inbox/`).
2. `brain.intake` writes raw (`trust: owner`). The Librarian compiles it to wiki (facts with evidence, MOC update, glossary).
3. The Schedule creates `post.draft` for the channel's Manager (Goal G3 by default, or G1 for YouTube).
4. The Writer drafts variants into `staging/<channel>/...` with the claims list linked to facts.
5. **Verification (section 6.8, content variant):** a fresh verifier checks claims ↔ facts, names of third parties, numbers and voice rules. A judge from a different family scores it against the brand rubric. A Verdict is bound to the **content hash**.
6. Then by **channel mode**:
   | Mode | Behaviour |
   |---|---|
   | `manual` | Approval in inbox. Tej approves/edits/rejects. With method `copy`, Tej posts himself (one-tap copy). |
   | `approve_then_auto` | Tej approves. publisherd posts at the scheduled slot. |
   | `auto_when_unavailable` | Approval is requested. If unanswered after `unavailableAfterHours` **and** the Verdict passed **and** the content passes the auto-policy (no new third-party names, no numbers not backed by facts, no private class, within daily limit, not in quiet hours), publisherd posts and notifies Tej with a 1-tap "take down" link. |
   | `auto` | Same auto-policy without waiting. Allowed only at Department L3. |
7. Any edit by Tej changes the hash, which needs a new Verdict (fast-path: Owner edits are trusted and only the deterministic policy is re-checked).
8. publisherd executes via the channel `method` (section 11.4 for secrets, 11.5 for browser sessions), records the post URL as evidence and a screenshot, and writes an audit event.
9. Engagement metrics are imported (API where available, else manual) into the Goal KR.

### 6.3 Meeting with directors
As v0.1: fleetd orchestrates turn-by-turn (each turn is a short `mid` Run with agenda + pre-read of at most 300 words + rolling transcript summary), the Owner can interject at any time, avatars walk to the conference room, the live transcript is stored, the CoS chairs and writes minutes, actions become Tasks with **one owner + a done-condition each**, and there is a per-meeting cost cap (default $1.50).

### 6.4 Revenue reinvestment and new-team proposal
1. Only evidence-backed revenue counts (bank/platform CSV import or read-only API). Agents cannot post `revenue`.
2. Revenue is tagged to a Goal. Monthly close applies the split (section 7.2) and feeds the weekly portfolio review (section 8).
3. Directors propose Experiments. Finance scores them. Council for large ones. Tej approves the envelope + org diff. `fleet sync`. New desks appear in the office.
4. Checkpoints and kill rules apply as in v0.1.

### 6.5 Credit exhaustion / rate-limit failover (C4)
1. The adapter classifies the error. Claude Max usage-limit messages count as `credits_exhausted` with a reset time when parseable.
2. The provider is marked `degraded` with a cooldown (retry-after, parsed reset time, or 5 min).
3. The Run is stopped. If no handoff exists, one is synthesized from events + `git diff --stat` + the last message (`trust: auto`).
4. Re-queue with `resumeFrom`. Walk the tier failover list (Claude Max → Codex → @any-api → @local → PAUSE), filtered by data class, envelope and family constraints. At PAUSE the Task goes to `blocked: provider` and Tej is notified (at most 1/hour). **Private Tasks/Departments use only `classChains.private` and pause instead of falling over (C13).**
5. The new Run's Brief says: *"Resuming. Verify state from files and git, not the handoff's claims."*
6. A 1-token probe every 15 min. On recovery, only new Runs prefer the primary.
7. **Judge independence is re-checked after failover.** If the implementer moved to OpenAI, the judge moves to Anthropic or another family.

### 6.6 Coach loop (PIP), now with rule promotion
1. Nightly: rolling per-Role stats (last 20 Runs): cost per accepted change, verdict fail rate, rework rate, escaped defects, retries, peak ctx, gate denials, stuck flags.
2. **Rule promotion first (cheapest, most durable).** Group `ReviewFinding`s by `ruleKey`. If a key recurs **3 or more times in 14 days** (across any Roles), the Coach proposes a **deterministic Rule**, in this order of preference:
   (a) lint rule / CI check / failing test in the repo,
   (b) a schema or policy rule in fleetd (for content: e.g. "every number needs a fact link"),
   (c) a skill-section edit,
   (d) only if none can be automated, a Coaching Note.
   A proposed Rule is a Task (owner: Platform Manager) with a done-condition: "the check fails on the 3 recorded findings' fixtures and passes on main". Owner approval is needed before it becomes `active` in the merge gate.
3. Roles still beyond thresholds (verdict fail above 30%, or cost per accepted change over 2x the fleet median) get a Coaching Note: at most 120 words, citing evidence, injected into the next 10 Briefs.
4. **Keep/revert:** after 10 Runs + golden tasks (graded by the cross-family judge): keep if the target metric improves by 15% or more and golden tasks pass, otherwise revert and file an anti-pattern. Kept notes are folded into the Role prompt at the weekly review (Owner approves the diff). At most 1 active trial per Role and at most 3 folded notes per Role.
5. **Coach accountability:** the Coach's own scorecard tracks its keep rate and how many Rules it promoted, then retired.

### 6.7 Onboarding wizard (`bun fleet init`)
1. `fleet doctor`: bun, git, disk encryption on (FileVault/LUKS), Infisical CLI/identity, provider detection (section 4.8), free port.
2. `$FLEET_HOME` location. Generate the age identity and store it in the OS keychain. Prompt Tej to save the recovery key in his password manager (section 11.6).
3. Company (legal entity, currency, tz, money mode = paper).
4. Goal portfolio (the `grill` skill): goals, KRs, shares, WIP limits.
5. Departments: the full life org template (section 8.4), with data class + autonomy each (C10, C11).
6. Name agents (real-person checkbox triggers the guard).
7. Providers + failover + data-class allowances + token caps.
8. Channels + Accounts (C16): for each existing account (LinkedIn personal or company page, YouTube channel, domain registrar, hosting) record vendor, account handle, owner (LLC/personal), channel mode/method (default `manual` + `copy`), ToS acknowledgement, and Infisical secret refs if any. Nothing is typed into the fleet as a secret. Stored in `org/accounts.json`.
9. Schedules. Then write config, `fleet sync`, start, open the office. First Task: CoS proposes a 2-week plan per Goal.

### 6.8 Verification pipeline (adopted from Lauren Tan, section 13)
Applies to every Task with a Proposal (code commit or external-bound content).
1. **Test-author** (for `hidden_tests` Tasks: risk high, overnight, or Project default) writes acceptance tests into `evals/hidden/<taskId>/` **before** implementation. This path is outside the implementer's read scope. Only the done-condition and acceptance text are shared.
2. **Implementer** (Task owner) works in an isolated worktree, writes the decision log, and ends with a Handoff (owner, inputs, done-condition, evidence). UI tasks must include **screenshots/video from actually running the app** (Playwright in the worktree; files in `runs/<id>/evidence/`).
3. **Verifier**: a fresh Run, different Agent, no implementer transcript. Gets the Proposal hash, acceptance, done-condition, hidden tests, and the handoff (marked as *claims*). It runs the app/tests itself and attaches evidence.
4. **Judge**: a different model family, rubric-only grading of the verifier's evidence vs acceptance. Returns a score + findings (`ReviewFinding` with `ruleKey`).
5. **Coordinator** (the Project Manager) issues the **Verdict** bound to the Proposal hash. **Any change to the commit/content requires a new Verdict.**
6. **Merge/publish gate** (deterministic): granted scope + passing Verdict on the *exact* hash + CI green + active Rules pass + Approval if required.
7. **Cost control:** for risk-low internal tasks, steps 1 and 4 are skipped (verifier only). Verification spend is tracked separately (`verifyCostUsd`) and tuned via the cost-per-accepted-change metric.
8. **Escaped defect:** any bug or issue later traced to a passed Verdict is linked back to it. That raises the verifier/judge Roles' fail stats and seeds a ReviewFinding.

### 6.9 Weekly portfolio review (C7)
Section 8.3.

### 6.10 External execution with secrets (C6)
Section 11.4.

### 6.11 Access request → grant / escalate (company-style)
Every Role has **minimal native tools** and explicit `readScopes` / `writeScopes` / `shellAllow` (command prefixes) in `org/roles.json`. Employees skip CLAUDE.md (`omitClaudeMd`). Enforcement happens in two places: the gateway (scope token on every MCP call) and, on Claude Code, the PreToolUse hook, which calls `fleetd /policy/check` for Read/Write/Edit/Bash/MCP. If fleetd is unreachable, the hook **denies** (fail closed).
1. A denied call returns `{ code: "needs_access", want: <Scope>, hint }`. The agent calls `access.request({ want, why, durationMin? })` and continues other work or ends with a handoff.
2. fleetd routes the request to the agent's **Manager**. The Manager (an agent Run, or the deterministic auto-rule below) can grant only a Scope that is a **subset of its own effective authority** (its scopes ∩ its Department's policy ∩ the company caps). Default duration is 60 min, max 24h, optionally bound to one Run or Task.
3. If the request exceeds the Manager's authority, it **escalates** automatically: Director → CoS → Tej. Anything touching governed paths, secrets, external tools, `private` data from a non-private Department, or money always ends at Tej.
4. **Auto-rule** (no LLM): read access to a file inside the Task's own Project paths that is not private and not governed can be granted by policy for the Run's lifetime.
5. Grants are audited, show up in the agent's scorecard (`accessRequests`), and expire automatically. Repeated identical grants (3 or more in 14 days) feed rule promotion: the Coach proposes a permanent Role-scope change for Tej to approve.

---

## 7. Finance and budget policy

### 7.1 Principles
- **Paper first (C1).** The full flow runs on paper. Execution is a human Task paid from the **Tula Solutions LLC** account (C2).
- Money moves only in deterministic code. LLMs propose and audit. They never hold credentials.
- Two independent caps once real (fleetd policy + issuer hard limit in paymentd).
- Token spend has its own envelope per Goal and Department (C12: $10/day cap).

### 7.2 Allocation rules (C12)
- Starting paper budget: **$100**. Reserve **30%** (Owner-only release). Operating 50% split by Goal shares, then by Department. Experiments pool 20% [safe default].
- Revenue split at monthly close: **40% reinvest** (C12), 30% reserve top-up until reserve = 3 months of burn, then that share goes to Owner draw, 30% Owner draw [safe default for the 30/30 split].
- **Token cap: $10/day company-wide** (API-equivalent; Claude Max usage converted from quota units) (C12). Per-Goal split follows `tokenShare`. When hit, new Runs queue until midnight local time and the CoS notifies Tej once.
- Unspent department envelopes: 50% roll over, 50% back to the pool.

### 7.3 Experiments and kill rules
Staged budgets ($10 → $25 → $50), pre-declared checkpoints, kill on no signal at checkpoint 1, freeze at 120% of stage spend, kill on 2 missed checkpoints. At most 3 concurrent experiments in v1 (they also count toward Goal WIP).

### 7.4 Approval thresholds (C11)
| Amount / type | L1 dept | L2 dept | L3 dept |
|---|---|---|---|
| ≤ $5 one-off, within envelope | Owner | Finance | Finance (auto if checks pass) |
| $5 to $25 | Owner | Owner (with Finance verdict) | Finance |
| > $25, recurring, or new vendor account | Owner | Owner | Owner |
| Daily company cap | $25 | $25 | $50 |

**Locked defaults (C11):** every Department starts at L1 except **Brain at L2**. **Finance approves paper spends ≤ $5 for any Department** (deterministic checks first). Everything above $5, every recurring or new-vendor spend, and every external action goes to Tej. Higher levels are opt-in per Department through the UI with passkey.

### 7.5 Graduation to real money (C1)
All must hold: 30 consecutive days of paper operation with zero policy violations, zero broken ledger chain events, at least 10 completed spend flows, every paper spend backed by a receipt, and the Owner explicitly opting in. Then paymentd goes live with LLC virtual cards (merchant-locked/single-use), an issuer hard monthly limit (Owner-set, default $50), an `fleet-pay` OS user and its own Infisical identity. Investing/trading stays paper indefinitely (A14).

---

## 8. Goal portfolio and prioritisation (C7)

### 8.1 Goals (initial)
- **G1 Content income:** YouTube/content revenue (KRs: uploads/week, watch hours, subscribers, $ revenue).
- **G2 Tula product:** ship and sell (KRs: shipped milestone, paying customers, MRR).
- **G3 Career + brand:** job + personal brand (KRs: applications/interviews/offers, LinkedIn posts/week, profile views).
Departments can serve multiple Goals (e.g. Content serves G1 and G3). Every Task carries one `goalId`, and cost is attributed to it.

### 8.2 Allocation mechanics
- **Shares:** each Goal has `budgetShare` and `tokenShare` (defaults 40/35/25 for G1/G2/G3, [safe default] S1) and a **floor of 15%** so no Goal starves.
- **WIP limits per Goal** (defaults): at most 2 active Projects and 3 concurrently running Tasks per Goal, at most 6 running company-wide on a laptop (A27). Excess work waits in `ready`.
- **Scheduler:** weighted fair queueing on token spend. Each Goal's virtual clock advances by cost / tokenShare, and the Dispatcher picks the ready Task from the Goal with the lowest clock. Inside a Goal: priority, then age (starvation aging +1 priority/48h). Owner-flagged urgent Tasks preempt and are charged to their Goal.
- **Deadline guard:** Tasks with hard deadlines (e.g. an interview prep date) get a reserved slot regardless of clock.

### 8.3 Weekly reallocation (Sunday review meeting)
1. Per Goal over the trailing 4 weeks: **measured value** = revenue + Σ(KR delta × `valuePerUnitUsd`) (Owner sets unit values, e.g. an interview = $X; S3), and **cost** = USD + quota-unit estimates.
2. ROI = value / cost. Shares move toward ROI ranking by **at most 10 percentage points per week**, respecting floors. G2/G3 have long feedback loops, so a Goal younger than 4 weeks is exempt from downward moves.
3. The CoS presents the proposed new shares in the Sunday meeting, Tej approves or edits, and the change is logged as a decision note.
4. A Goal under its floor for 2 weeks with negative trend prompts a "keep/kill/rescope" question to Tej (never auto-kill a Goal).

---

### 8.4 Starter org (C10): full life org from day one, shipped as template `org-full-life`
*This table is the template's content. Importing it creates editable departments, teams, roles and agents. Tej can delete, rename or restructure any of it in the Org editor (C17).*

Titles are display names until Tej renames them in the UI (naming convention: `"<Title>"` now, any name later, `namedAfterRealPerson` set when it's a real person; S4). Departments marked *dormant* exist with a Director and a weekly check-in only, so they cost almost nothing until Tej gives them work.

| Department | Director (tier) | Managers → Employees (Phase 1 roles in **bold**) | Goals | Data class | Autonomy | Phase 1 state |
|---|---|---|---|---|---|---|
| CEO office | **Chief of Staff** (deep) | **Intake Router** (cheap), Coach (deep, Phase 3), Council Chair + 5 voices (Phase 2) | all | internal | L1 | active |
| Content | Content Director (mid) | **LinkedIn Manager** → **Writer** (mid), **Editor** (cheap), **Verifier** (mid), **Judge** (mid, other family); YouTube Manager → Scriptwriter, Producer (Phase 2) | G1, G3 | public-bound | L1 | active |
| Product (Tula) | Product Director (mid) | Tula Product Manager → Coder, Reviewer/Verifier, Test-author, Scribe, Diagrammer | G2 | internal | L1 | dormant (builds the fleet itself from Phase 2) |
| Career | Career Director (mid) | Job Search Manager → Researcher, Resume Tailor; Brand Manager (shares Content's LinkedIn pipeline) | G3 | internal (resume/job data) | L1 | dormant |
| Finance | Finance Director / Auditor (deep) | Ledger Manager → Bookkeeper (cheap) | all | internal | L1 (approves paper ≤ $5) | active (ledger only) |
| Brain | Brain Director (mid) | **Librarian Manager** → **Curator** (cheap), **Compiler** (cheap/mid), Linter (deterministic job, not an agent) | all | internal | **L2** | active |
| Relationships | Relationships Director (mid, private) | Relationships Manager → Planner (dates, reminders, gift ideas) | personal | **private** | L1 | dormant, fail-closed routing |
| Personal | Personal Director (mid, private) | Life Admin Manager → Organizer | personal | **private** | L1 | dormant, fail-closed routing |
| Health | Health Director (mid, private) | Fitness Manager → Planner (meal/training plans; no medical advice beyond general info) | personal | **private** | L1 | dormant, fail-closed routing |
| Security (shared) | Security Director (mid) | SecOps Manager → Scanner (cheap) | all | internal | L1, veto on any external action | active (scans + isolation check) |

Personal departments sit outside the G1-G3 money portfolio. They get a fixed token share (default 10% of the daily cap, S2) and are excluded from ROI reallocation.

## 9. Autonomy levels and kill switch
Levels L0 to L4 as in v0.1 (L0 observe; **L1 propose (default)**; L2 act internally; L3 bounded external; L4 reserved). Changes:
- Channel modes `auto_when_unavailable` and `auto` require Department L3 **and** the isolation check (section 11.4) passing.
- Raising a level needs the Owner + passkey. Lowering is instant.
- **Kill switch** (UI button, `bun fleet stop`, or the file `$FLEET_HOME/STOP`), effective within 2s: the gateway rejects tools, Runs are killed, schedules pause, publisherd refuses and **closes all browser contexts**, paymentd freezes cards, and Infisical machine identities for execution services are optionally revoked (`fleet stop --revoke`).
- Auto-tripwires per Department: token burn over 3x the 7-day median per hour, more than 20 gate denials per hour, a loop detected, a ledger/audit chain error, or a post taken down by the platform.

---

## 10. Security and threat model

### 10.1 Assets
Owner accounts/tokens, LLC money, private personal/relationship/health data, repos, reputation, named people's privacy, provider credits.

### 10.2 Threats and controls
| Threat | Control |
|---|---|
| Prompt injection via web/email/docs | Web content enters only via Researcher roles with **no external-action, spend or secret-adjacent tools**. Stored as `trust: web`, wrapped as untrusted in Briefs. Web-derived facts need a second source or Owner promotion. Gateway tools take structured args only. |
| Self-approval / governance tampering (scaffold bug, section 21) | Governed state is owned by fleetd and outside agent scopes. Approvals and Verdicts are bound to hashes and single-use. Hash-chained audit. |
| Secrets exposure | Infisical + execution-service isolation (section 11.4). Agent env scrubbed. Output redaction. |
| **Shared credentials across roles** (the flaw in Lauren Tan's setup) | Separate OS users + separate Infisical machine identities + separate browser profiles per execution service and per channel. Agents run as `fleet-agent`, which has no Infisical identity at all. |
| Runaway cost | Per-Run caps, envelopes per Goal/Department, maxTurns, detectors, tripwires, kill switch. |
| Private data to the wrong provider | Data-class filter in Brief generation + provider allow-lists + audit of every class crossing (section 11.3). |
| Destructive shell | Worktrees, DENY_CMD (kept from scaffold), protected main, merge only via gate. |
| Supply chain | New dependencies flagged and reviewed. Lockfile diff in Verdict evidence. |
| ToS / bans | Per-channel risk badge, daily limits, quiet hours, human-like pacing, take-down link. Tej's call (C6). |
| Impersonation of named people | Section 10.4. |
| UI/API abuse | Localhost bind + Tailscale only. Owner session + passkey for L3+ ops. CSRF. |
| Laptop theft/loss | Disk encryption required, private class age-encrypted, no secrets on disk, Infisical identities revocable remotely. |

### 10.3 Data classes
Defined in section 11.2.

### 10.4 Real-people names (S4)
Display label only. Fixed guard in the role prompt. Persona comes only from Role duties. Display names are stripped from external output. Person notes are `private`.

### 10.5 Posting modes: risk shown in UI (C6)
| Method | Typical ToS risk | Notes |
|---|---|---|
| `copy` (Tej posts) | low | Safest. Default for new channels. |
| `official_api` | low to medium | Subject to API access approval and rate limits per platform. |
| `browser` automation | **high** for LinkedIn and most social platforms (automation is commonly prohibited; account restriction risk) | Allowed because Tej chose it. Badge, explicit acknowledgement at setup, conservative daily limits (default 1 post/day/channel), deterministic scripts preferred over LLM-driven browsing. |

---

## 11. Secure-by-default data handling (new)

### 11.1 Principles
Least data per Brief. Secrets never reach agents. Private data is encrypted when not in active use. Every class crossing and secret use is audited. Everything can be restored, and restores are tested.

### 11.2 Data classes
| Class | Examples | Storage |
|---|---|---|
| `public` | approved posts, public repo code | plain files |
| `internal` (default) | tasks, plans, ledger, metrics, most brain | plain files on an **encrypted disk** (FileVault / LUKS required, checked by `fleet doctor`) |
| `private` | relationships, health, personal finance, person notes, private Goal details | **age-encrypted per file** (`*.md.age`) under `brain/private/` and in Task bodies flagged `private`. Decrypted only in fleetd memory. Never in git, never in the SQLite index in plaintext (only a keyed hash index of titles/tags). |
| `secret` | API keys, tokens, cookies, card data, passwords | **only** in Infisical (+ encrypted browser profiles in `exec/`). Never in files, prompts, logs or brain. The brain lint fails on secret patterns. |

### 11.3 What may go into prompts, per class
| Class | Allowed providers | Rules |
|---|---|---|
| public | any configured | none |
| internal | Claude Max, Codex/OpenAI, local, any API key present (C4); API routers (OpenRouter-style) on by default only for `public` [safe default S6] | Brief includes only referenced files/sections |
| private | **Claude Max + loopback-local only, enforced in code, fail closed (C13)** | Only Runs whose Department has `dataClass: private`. Minimum necessary: only notes explicitly referenced by the Task, passed as excerpts. Third-party names replaced by stable aliases (`[Person-A]`) unless the Task needs the name. Never to web-ingesting Roles. Never in meeting transcripts with non-private departments. Each inclusion is audited (note id, provider, run). |
| secret | **never** | The redaction filter blocks known secret values and patterns in Briefs, tool results, logs and UI events. |

Practical note: subscription CLIs (Claude Max, Codex) and API providers have their own retention/training terms. Tej's provider approval for `private` is a policy flag the Brief generator enforces, not a guarantee about the vendor.

### 11.4 Secret handling with Infisical (C6)
- **Layout:** Infisical project `tula-fleet`, environments `laptop` / `vps`, folders `/providers`, `/channels/<channelId>`, `/payments`, `/backup`.
- **Identities (Universal Auth machine identities), least privilege:**
  - `launcher`: read `/providers` (API keys for fleet-loop providers). Used by fleetd's adapter launcher to inject a key into the **HTTP client inside fleetd** for fleet-loop Runs. The key never enters the agent's environment (fleet-loop model calls are made by fleetd, not by the agent process).
  - `publisherd`: read `/channels/*` only.
  - `paymentd`: read `/payments` only (Phase 5).
  - `backup`: read `/backup` only.
  - **`fleet-agent` has no identity.**
- **Bootstrap secret:** each identity's client secret lives in the OS keychain (macOS Keychain / libsecret) of that service's OS user, or in a root-owned `0400` systemd credential on the VPS. It is never in `$FLEET_HOME`.
- **Execution flow** (e.g. auto-post):
  1. The agent calls `publish.stage(item)`. Later fleetd decides it is executable (Verdict + mode policy + Approval if needed).
  2. fleetd sends publisherd `{ itemId, contentHash, approvalId|policyDecisionId, channelId }` over a Unix socket, HMAC-signed.
  3. publisherd re-verifies: hash matches staged content, approval valid/unconsumed, kill switch off, daily limit, quiet hours.
  4. publisherd fetches `/channels/<id>/*` from Infisical (in memory, TTL ≤ 5 min, no disk cache), executes, then zeroes its references.
  5. It returns `{ url, screenshotPath, status }` only. Secret values never return.
- **Claude Max/Codex CLI auth (honest limit):** these CLIs store their own login tokens readable by the OS user running them. Mitigation: they run as `fleet-agent`, which holds *only* those vendor logins (no Infisical identity, no channel/payment access). The worst case is misuse of provider quota, which is capped by tripwires.
- **Laptop, Phase 1:** a single OS user is acceptable *only* because no channel or payment secrets are loaded (paper money, `copy` posting). **Hard rule:** `fleet doctor` blocks channel modes other than `manual+copy` and blocks paymentd until the isolation check passes (separate OS users exist, permissions correct, `fleet-agent` can't read `exec/` or keychain items).
- **What is logged:** secret *name*, version, service, purpose (`itemId`/`runId`), outcome, timestamp. **Never values.** Infisical's own audit log is the second record.
- **Rotation:** `rotationDays` per SecretRef (default 90). A UI badge shows when rotation is due. Rotation after any suspected leak or `fleet stop --revoke`.

### 11.5 Browser-automation sessions and cookies
*Superseded in detail by section 28.5 (per-Connection profiles, agent-driven browsing under policy). The rules below still apply.*
- One **persistent Playwright context per channel**, owned by `fleet-pub`, stored in `exec/browser/<channelId>/`, **age-encrypted at rest** (decrypted to a `0700` temp dir only while publisherd uses it, re-encrypted and wiped on close).
- Login happens once by Tej in a headed window launched by publisherd (`fleet channel login <id>`). Credentials typed by Tej go to the site, not the fleet. Optional username/password from Infisical for re-login.
- Agents never get the browser, the profile, cookies or CDP access. They supply structured payloads only. Posting scripts are deterministic per platform. When an LLM-driven step is unavoidable (UI drift), it runs inside publisherd's sandbox with a domain allow-list, no other credentials, screenshot evidence, and a step cap.
- Cookies/sessions are **never logged, exported or included in evidence screenshots' metadata**. Screenshots are cropped to the post area where possible.
- Session expiry is detected: the channel moves to `needs_login` and Tej is notified. The kill switch closes contexts. `fleet channel forget <id>` securely deletes the profile.

### 11.6 Key management
- **age identity** (`fleet` key) for private data and browser profiles: generated at init, stored in the OS keychain of the `fleet` OS user (VPS: systemd credential).
- **Recovery:** an age recovery recipient is generated at init. Its private key is shown once for Tej to store in his password manager (not in Infisical, which keeps the data key and the secrets store apart). Every encrypted file has both recipients.
- **Rotation:** `fleet keys rotate` re-encrypts to new recipients. Runs on suspected compromise or yearly.
- Infisical identities are revocable remotely (laptop loss playbook: revoke identities, rotate channel tokens, rotate the age key on the next host).

### 11.7 Audit log and backup
- **Audit:** `audit/audit.jsonl`, hash-chained, append-only via fleetd. It records approvals, Verdicts, grants, secret uses (names only), data-class crossings, config/org changes, kill switch, exports/imports, backups, key rotations. The daily chain head goes into the backup and the Owner digest, so tampering shows up.
- **Backup:** nightly `fleet backup` uses **restic** (client-side encrypted, deduplicated) of `$FLEET_HOME` minus derived state (`state/fleet.sqlite`, generated files) to (a) an external/local disk target and (b) an offsite bucket (S5). The restic password is in Infisical `/backup`. Private files are already age-encrypted inside, so they are double-encrypted. Retention: 7 daily, 4 weekly, 12 monthly. **Monthly automated restore test** into a temp dir: verify hash chains, decrypt a sample private note, `fleet reindex`. The result shows up in the digest.
- `company/` git repo (internal/public only, private and `exec/` git-ignored) is pushed to a **private** GitHub repo for history. It is not the backup of record.

### 11.8 Laptop → VPS migration runbook (C5)
1. **Prepare VPS:** a Linux VPS with LUKS-encrypted data volume (or provider disk encryption + age for private data), Tailscale, bun or Docker, OS users `fleet`, `fleet-agent`, `fleet-pub`, `fleet-pay`. `fleet doctor --host` passes.
2. **Infisical:** create machine identities for the `vps` environment (same folder layout) and put the bootstrap secrets into systemd credentials. Do not copy laptop identities.
3. **Provider logins on VPS:** log in to Claude Code and Codex as `fleet-agent` (headless login per the vendor's documented method; verify at migration time, A30). API keys are already in Infisical.
4. **Freeze laptop:** `fleet stop --drain` (finish or hand off running Runs, pause schedules, release the lease).
5. **Export:** `fleet export --to <file>` makes a tarball of `$FLEET_HOME` minus derived and host files, encrypted with age to the VPS `fleet` key + recovery key. It includes the audit chain head.
6. **Transfer** over Tailscale (scp). **Import:** `fleet import <file>` verifies the ledger/audit/approval chains, decrypts, places files, runs `fleet reindex` and `fleet sync`.
7. **Browser sessions:** do *not* copy cookies (IP/device change often triggers platform security checks). Re-run `fleet channel login` per channel on the VPS (headed via a VNC/noVNC session over Tailscale).
8. **Start:** `fleet start` acquires the lease and runs the catch-up policy for missed schedules. Smoke test: one cheap Task, one staged post (manual mode), a backup run.
9. **Laptop becomes a client:** its fleetd stays stopped (or runs `--ui-only` against the VPS). Securely delete the laptop `$FLEET_HOME` after 14 days of clean VPS operation, or keep it as an encrypted backup target.
10. **Rollback:** the same procedure in reverse. The lease prevents both hosts from being active at once.

---

## 12. Recurring loops
As v0.1 (catch-up `once` default, per-fire cost caps, auto-pause after 3 failures, pause/postpone/skip in UI). **Added:** overnight or unattended Schedules must declare a done-condition, run in an isolated worktree, and write a decision log. Without those, the Schedule cannot be enabled. Templates: daily digest, post drafts per channel, weekly portfolio review (Sun), monthly close, nightly Coach + brain lint + rule promotion, weekly golden tasks, nightly backup, monthly restore test.

---

## 13. Lauren Tan (poteto) practices: evaluation

Sources are self-reported by her. The article author's analysis is treated separately. The 1,000 PRs/month figure is unaudited and not a target.

| Practice | Verdict | How it's folded in |
|---|---|---|
| **Chief-of-Staff bot routes bugs/ideas to feature bots** | **Adopt** | The CoS is the intake/router under Tej (section 2). Routing to Department + Goal + one owner. |
| **One owner per PR/Task** | **Adopt** | `Task.ownerAgentId` is required and singular. Helpers and Verifiers are never owners. |
| **Handoffs name owner + inputs + completion condition** | **Adopt** | The Handoff schema enforces it. The gateway rejects incomplete handoffs. |
| **Fresh verifier workers + coordinator verdict; a changed commit needs a new verdict** | **Adopt** | Section 6.8. Verdict bound to the Proposal hash (commit or content). |
| **Tests hidden from implementers** | **Adopt, selectively** | High-risk, overnight and golden-task Tasks only (cost). `evals/hidden/` is outside implementer read scope. |
| **Judge from a different model family** | **Adopt** | `taskOverrides.judge.preferFamilyOtherThan`. Weak-independence fallback is flagged in the Verdict and on the scorecard. |
| **Agents run the app and return screenshots/videos as evidence** | **Adopt** | Required evidence for UI tasks. EvidenceRef with sha256. |
| **Overnight runs: checkable finish condition, isolated worktree, decision log** | **Adopt** | Section 12. The Schedule can't be enabled without them. |
| **Repeated review comments → failing rules/CI checks** | **Adopt (core of the Coach loop)** | Section 6.6 step 2. Mechanize before prompting. |
| **Merges require granted scope + passing gate** | **Adopt** | The merge/publish gate in section 6.8 step 6. |
| **She sets goals, permissions, acceptance criteria and reviews** | **Adopt** | That's the Owner's job description in this system. The approvals inbox and Portfolio review are built around it. |
| **/goal, /loop, /swarm commands** | **Adapt** | UX verbs: `fleet goal` (Portfolio), `fleet loop` (Schedule), `fleet swarm` (parallel Tasks under WIP limits). Also exposed as CoS chat commands. |
| **pstack (open-source skills/playbooks)** | **Evaluate later** | Check license and content. Import individual skills into `engine/skills/` if useful (A31). |
| **Engineering bot managing cloud coding agents** | **Defer** | Local worktrees first. Cloud agents become an adapter later. |
| **Bots sharing one account / cloud computer / browser sessions** | **Reject** | The explicit anti-pattern (section 10.2): credential boundaries are OS-user + identity + profile boundaries. |
| **Article-author metrics: accepted fixes, review time, rework, escaped defects, cost per accepted change** | **Adopt** | Section 14. Cost per accepted change is the primary efficiency metric. |

---

## 14. Metrics and coaching design
- **Ingestion:** Claude Code OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP → fleetd :4318; token.usage, cost.usage, api_request, tool_result, skill_activated; beta traces with agent_id/parent_agent_id, A15). Codex and fleet-loop send normalized `usage` events. Join on `fleet.run_id` via `OTEL_RESOURCE_ATTRIBUTES`.
- **Outcome metrics (primary, per Role/Department/Goal):**
  - **accepted changes** (Verdict pass + gate passed + merged/published)
  - **cost per accepted change** (implementation + verification + rework USD/quota)
  - **review time**: Verdict latency *and* **Owner approval latency** (often the real bottleneck)
  - **rework rate**: share of Proposals needing more than 1 Verdict
  - **escaped defects**: issues traced to passed Verdicts, or posts taken down/edited after publishing
- **Efficiency metrics (secondary):** tokens, cost, turns, wall time, peak ctx %, retries, gate denials, access requests, helpers, verification cost share.
- **Detectors:** stuck, loop, waste, context bloat, gate thrash (as v0.1), plus **judge-independence degraded** and **verification skipped on a risk-high task** (the latter blocks the gate).
- **Bottleneck view:** the task DAG critical path, plus an approval-queue age heat map per Goal.
- **Golden tasks** per Role: run weekly and on any prompt/model/routing/Rule change. Graded by the cross-family judge. A regression blocks the change.
- **Coaching:** section 6.6.

---

## 15. UI scope
React 18 + Vite + TS, PixiJS v8 office, TanStack Query + WS, Tailwind, served by fleetd. Mobile-responsive. **Phase 1 milestone M1 builds the first three screens (C14):** approvals inbox (phone-first), kanban, simple office (+ a read-only workflow view with run overlay). **Milestone M2 adds every editor (C17)**, all rendered from the same JSON Schemas:
- **Org editor:** departments, teams, roles, agents, display names, tiers, native tools, scopes, budgets, autonomy (≤ parent).
- **Workflow builder** (section 27.7).
- **Connections manager + Create-team wizard** (section 28.2).
- **Schedule editor:** cron/interval pickers, catch-up policy, pause/postpone.
- **Policy/threshold editor:** approval thresholds, caps, autonomy, data-class rules. Risk-widening fields are marked and need owner confirmation.
- **Provider/model-routing editor:** detected providers, tier maps, failover chains, private eligibility (owner-locked), prices.
- **Templates:** import (preview diff + params) and export.
- **First-run wizard:** the same forms in a guided sequence.
- **Version history** on every object (diff, revert).
- **Approvals inbox:** one tap. Verdict + evidence thumbnails, ToS badge, "auto-posts in Xh if unanswered" countdown for `auto_when_unavailable`.
- **Portfolio:** goal shares, floors, WIP usage, ROI trend, the weekly reallocation proposal.
- **Kanban:** filter by Goal/Department. Single-owner avatar. The verify column shows Verdict state.
- **Office (pixel):** rooms per Department, conference room, status, walking, bubbles with real text, replay.
- **Meetings:** live transcript, Owner input, minutes → Tasks.
- **Org editor:** diff to `org/*.json` → validate → sync.
- **Finance:** paper/real badge, envelopes per Goal/Department, ledger with receipts, spend requests, experiments, revenue import.
- **Channels:** mode/method per channel, ToS risk, login status, daily limits, quiet hours, take-down.
- **Metrics:** outcome metrics first, detectors, failover log, coaching and Rule promotions.
- **Security:** audit log viewer, secret-use log (names), data-class crossings, isolation check, backup/restore-test status, kill switch.
- **Brain:** search, assumptions queue, lint. Private notes appear only after an Owner unlock.

---

## 16. Instruction files and generation
As v0.1: `company/org/*.json` + `engine/prompts/` generate `.claude/agents/*.md`, `CLAUDE.md`/`AGENTS.md` (tiny, identical universal rules), codex config fragment. fleet-loop reads org directly. `fleet sync --check` runs in CI. **Added:** role prompts include the Handoff contract and evidence rules. Verifier/Judge prompts are generated from a shared template and never see implementer role text.

---

## 17. Repo layout
```
tula-fleet/                       # engine repo (shareable)
  engine/
    fleetd/{api,ws,scheduler,dispatcher,policy,ledger,portfolio,brain,verify,metrics,coach,meetings,audit,crypto}/
    gateway/  adapters/{claude-code,codex,fleet-loop}/  router/  schema/  hooks/  prompts/  skills/
    workflow/{engine,validate,nodes,sim}/  connectors/{builtin/manual,builtin/brain,builtin/notify,linkedin,youtube}/  config/
    templates/                   # DATA packages only: org-full-life, wf-learning-to-linkedin, team-youtube-channel, defaults-v1
    cli/                          # fleet init|start|stop|sync|doctor|approve|reindex|eval|backup|export|import|keys|channel|goal|loop|swarm
    publisherd/  paymentd/
  ui/
  company.example/                # fake sample company for cloners/tests
  deploy/{Dockerfile,compose.yaml,systemd/}
  tests/
  docs/{SPEC.md,PHASE-1-PLAN.md}
$FLEET_HOME/  (default ~/.tula-fleet; never inside the engine repo)
  company.json org/ brain/{raw,wiki,private(*.age),decisions,diagrams} tasks/ runs/ meetings/ ledger/ approvals/
  grants/ audit/ staging/ evals/{golden,hidden}/ exec/(service-owned) state/ host.json STOP?
```

---

## 18. Phased roadmap

**Phase 0: Foundations (1 week).** The tasks are P0-1 to P0-7 in PHASE-1-PLAN.md, including every scaffold bug in section 21. *Accept:* tests green; `tsc --strict` passes; a self-approval write is denied; doctor fails on an unencrypted disk.

**Phase 1 (4-5 weeks; backlog in PHASE-1-PLAN.md v1.1).** M1 (weeks 1-3): the C15 slice runs as the workflow template `wf-learning-to-linkedin` on the generic engine, with a manual connection. M2 (weeks 3-5): every editor, the builder, the Create-team wizard, template import/export and the first-run wizard. M1 slice: learned → brain → LinkedIn draft → verifier (+ judge if a second family is linked) → Verdict → approval inbox (phone) → `manual+copy`. Includes the Claude Code adapter, gateway (`brain.intake`, `task.*`, `publish.stage`, `handoff.write`, `evidence.attach`, `skill.*`), scheduler with catch-up, scorecards with outcome metrics, kill switch, nightly backup. *Accept:* overnight note → staged, verified draft by 08:35. One-tap approve on phone. Scorecard shows cost per accepted post. The STOP file halts a Run within 2s. **The same Task resumed on Codex (or a local model) from its Handoff produces a draft.** A backup restore test passes.

**Phase 2: Org, meetings, portfolio, isolation (2-3 weeks).** Org editor, CoS intake routing, `task.delegate`, meetings, ADR/Excalidraw, Council. Portfolio allocator + WIP + weekly review. **OS-user isolation on the laptop** (`fleet-agent`, `fleet-pub`). Infisical identities. *Accept:* the isolation check passes, so `fleet-agent` cannot read `exec/` or keychain items. A 3-item meeting for under $1.50. Weekly reallocation proposal generated from real data.

**Phase 3: Verification depth, finance (paper), governance, metrics (3 weeks).** Hidden tests, cross-family judge, rule promotion, Coach loop with golden tasks. Ledger/envelopes/spend flow/experiments/revenue import. Access grants. Autonomy levels. Tripwires. Codex + fleet-loop adapters with automatic failover. *Accept:* $10 domain flow end-to-end on paper. Forced 429 → failover → resume. A recurring finding becomes an active CI check. A coaching trial auto-reverts on a regression fixture.

**Phase 4: External publishing (after isolation passes).** publisherd with `official_api` and `browser` methods, channel modes incl. `auto_when_unavailable`, encrypted browser profiles, take-down flow. Optional VPS migration (runbook 11.8). *Accept:* an auto-post when unanswered happens only with Verdict + policy pass. Every post has evidence + audit. Kill switch closes browser contexts.

**Phase 5: Real money (after the section 7.5 graduation criteria).** paymentd + LLC virtual cards + issuer caps + passkey. *Accept:* an issuer-side decline above the cap is proven. 100% of spend has approval + receipt.

**Phase 6: Compounding.** Brain compile/lint (Karpathy-style), experiments at scale, PWA polish, optional Postgres.

---

## 19. Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Scope explosion (3 goals × life OS × game UI) | high | high | Portfolio WIP limits, vertical slices, phase gates |
| Parallel goals starve each other or thrash | med | med | Floors, max 10pp shift/week, 4-week exemption, deadline guard |
| Verification doubles cost | med | med | Selective hidden tests/judge by risk; track cost per accepted change |
| Browser-automation bans | high (if used) | high | Per-channel risk badge, limits, deterministic scripts, take-down; Tej's call |
| Single-user laptop phase leaks secrets | med | high | No channel/payment secrets until the isolation check passes |
| Subscription quota opacity (Claude Max/Codex) | high | med | Quota units, reset-time parsing, failover |
| Vendor CLI changes | high | med | Isolated adapters, recorded-fixture contract tests, doctor version checks |
| Plausible false facts | high | high | Evidence-required notes, verifier claim checks, Owner promotion for web facts |
| Approval fatigue | high | high | `auto_when_unavailable` with strict policy, batched digests, risk-ranked inbox |
| Key loss locks private data | low | very high | Recovery recipient in password manager, monthly restore test |
| Double-active hosts after migration | low | med | Lease + runbook |
| Real-money loss | low | high | Paper first, graduation criteria, dual caps |

---

## 20. Brain design (summary)
`raw/` → `wiki/` (MOCs, facts, patterns, anti-patterns, people (private), glossary) → `decisions/` + `diagrams/`. Compile Runs add `evidence:` back-links. Nightly deterministic lint: missing evidence, orphans, broken links, stale, duplicates, assumptions cited as evidence, private→non-private links, **secret patterns (hard fail)**. Navigation via `00-INDEX.md` → MOCs. Agents use `brain.search` / `brain.read(path, section?)`. Inspirations: Karpathy (raw → compiled wiki, health checks), Matt Pocock (grill-me, small skills, ubiquitous language, vertical slices/TDD), Lauren Tan (section 13).

---

## 21. Scaffold review → Phase 0 tasks
Every known scaffold defect is a Phase 0 task in PHASE-1-PLAN.md. **(verified)** means reproduced against `/mnt/user-data/outputs/tula-fleet/`.

| Task | Defect | Fix |
|---|---|---|
| P0-4 | **Self-approval (verified):** `security-gate.ts` allows `Write` to `fleet/approvals/approved/<id>.json`, and `isApproved()` only checks the file exists. | Approvals move to fleetd-owned `$FLEET_HOME/approvals/*.jsonl` (hash-chained). Agents get no write scope there, enforced by the gate + scope checks. Test: writing an approval file is denied and has no effect. |
| P0-4 | **Approval consumed before the action runs:** `isApproved()` deletes the file at check time, so a failed tool call burns the approval. No expiry. | Two-phase: `reserve` at PreToolUse → `consume` on PostToolUse success / `release` on failure. `expiresAt` (72h default). Bound to the action hash. |
| P0-5 | **Races:** `event-log.ts` and `context-guard.ts` read-modify-write `links.json` / `ctx.json` from concurrent hooks. Parent linking by `agent_type` mismatches parallel same-type spawns. | Hooks append to `events.jsonl` only (O_APPEND, one line < PIPE_BUF). fleetd derives links/ctx in memory and persists them via `store.write` with a lock. Link by `agent_id` (+ `parent_agent_id` from OTel traces where present). |
| P0-1 | **Scripts pointing at missing files (verified):** `doctor`, `brain:lint`, `canvas`, `dash`, `demo`, `access` in package.json, and `new-adr.ts` referenced by the adr skill. | Remove them now. Each comes back with the slice that creates the file. CI check: every package.json script target exists. |
| P0-1 | **tsc errors (verified):** `Cannot find type definition file for 'bun'` (deps not installed, `@types/bun: latest`). `strict: false`. Untyped params in `route.ts` etc. | Pin `@types/bun` and `typescript`, `strict: true`, add types, `bun run typecheck` in CI. |
| P0-1 | `common.md` tells agents to use `skill.ts <skill> --index`, but that flag doesn't exist (it only works because index is the default). | Replace with gateway `skill.index` (P1-2). Keep the CLI as a debug tool with a real `--index` flag. |
| P0-7 | CEO agent `id: "tej"` impersonates the Owner. Org mixes roles and instances. Native `Agent(child,...)` delegation syntax is unverified. | Rename to `cos` inside the `org-full-life` **template** (data). Split `org/{departments,teams,roles,agents}.json`. A template importer creates them, and a generator that works on any org emits `.claude/agents` (v1.1: no fixed org in code). Org delegation goes through `task.delegate` (Phase 2). |
| P0-6 | `providers.json` too thin. `.claude/settings.json` `"agent": "tej"` key unverified. | New providers schema (section 4.8). Drop the key. |
| P1-6 | `pre-compact.ts` writes a placeholder handoff. | A synthesized handoff with the section 5 schema. |
| P1-3 | `EXTERNAL_CMD` regex can be bypassed (`curl -X POST`, `python -c`...). | Accepted as a known limit of the secondary layer. The primary control is no credentials in agent env + gateway-only external actions. |

**Keep:** router core, DENY/SECRET pattern lists, ctx `evaluate()`, event vocabulary, `skill.ts` split/render (moves into the gateway), all 10 skills (add `verify`, `judge-rubric`, `test-author`, `rule-promotion`, `finance-audit`, `meeting-chair`, `brain-compile`, `coach`), `sync-agents.ts` (becomes the claude-code adapter's `generate()`).

---

## 22. Deferred
Avatar art/licensing. Voice input. Gmail/Calendar integration scope. Engine license. Cloud coding-agent adapter. pstack import (license check). Exact Codex capabilities and Claude Code hook ctx fields (verified in P1-5/P1-16).

---

## 23. Resolved questions
Round 1: money mode, entity, private data policy, provider order, hosting, posting control, goals, Lauren Tan. Round 2: Infisical hosting, starter org, autonomy defaults, paper budget, private-data providers, first UI, first slice, existing accounts. All are in section 0. No open questions block Phase 0-1.

---

## 24. Remaining assumptions (technical; verified during build)

| ID | Assumption | Status / verified in |
|---|---|---|
| A6 | SQLite derived + files canonical; Postgres deferred. | [safe default] |
| A8 | `$FLEET_HOME` is a private git repo (internal/public only). private/ and exec/ are never committed. | [safe default] |
| A9 | Top agent = Chief of Staff (intake + routing). | locked (C10) |
| A10 | Phone UI = responsive web over Tailscale + ntfy push. | [safe default] |
| A13 | Portability proven in Phase 1 (P1-16). | [safe default] |
| A14 | Trading/investing paper-only indefinitely. | [safe default] |
| A15 | Claude Code OTel metric/event names and transcript usage fields as briefed. | verify in P1-7 |
| A16 | Open/local models default to cheap tier + `open_ok` tasks. | [safe default] |
| A17 | Codex CLI: MCP, AGENTS.md, `exec` with JSON events, sandbox/approval policy. | verify in P1-16 |
| A20 | Single owner, single active host. | [safe default] |
| A21 | Meetings orchestrated turn-by-turn by fleetd. | [safe default] |
| A24 | UI stack React + Vite + PixiJS + Tailwind. | [safe default] |
| A27 | WIP: 2 projects + 3 running Tasks per Goal, 6 running company-wide on laptop. | [safe default] |
| A30 | Headless Claude Code/Codex login on a VPS under a dedicated user. | verify at migration |
| A31 | pstack skills evaluated later, license permitting. | [safe default] |
| A32 | Phase 1 runs single-user on the laptop with no channel/payment secrets loaded. External auto modes unlock only after OS-user isolation (Phase 2). | [safe default] |
| A34 | Owner edits to a verified draft skip re-verification (deterministic policy re-check only). | [safe default] |
| A35 | Hidden tests + cross-family judge only for risk-high, overnight and golden tasks. | [safe default] |
| A36 | Claude Max covers Phase 1 volume (≈ 20-60 Runs/day) within plan limits. | verify in P1-7 metrics |

---

## 25. Safe defaults Tej can override (one place)
All of these are values in the importable template `defaults-v1`, applied on first import. Change them in the matching UI editor or file. Effects follow section 26.5 (tightening applies immediately; widening applies on the next run and needs owner confirmation).

| ID | Default | File / setting | Was |
|---|---|---|---|
| S1 | Goal shares G1 content 40% / G2 Tula 35% / G3 career 25%; floor 15%; max shift 10pp/week; 4-week grace | `org/portfolio.json` | A26 |
| S2 | Personal departments (Relationships, Personal, Health) get a fixed 10% of the token cap, outside ROI reallocation | `org/portfolio.json` | new |
| S3 | `valuePerUnitUsd` per KR: unset (ROI = revenue only) until Tej sets values; suggested starters: interview $200, offer $2,000, LinkedIn post that beats median engagement $10, paying Tula customer = first-year revenue | `org/goals.json` | A28 |
| S4 | Agent names = titles. Real-person names are labels only: no tone mimicry, never external, transcripts private | `org/agents.json` / Org editor | A11 |
| S5 | Backups: restic nightly to a local external disk; offsite bucket (B2 or R2) added when Tej creates one; monthly restore test | `org/backup.json` | A29 |
| S6 | OpenRouter-style API routers allowed for `public` only; direct vendor API keys (Anthropic/OpenAI/etc.) allowed for `public` + `internal` | `org/providers.json` | new |
| S7 | Autonomy beyond C11: Content, Product, Career, Finance, Relationships, Personal, Health, Security, CEO office all L1; no Department above L2 without passkey | `org/departments.json` | A22 |
| S8 | Channels start `manual` + `copy` (Tej posts) for every account | `org/accounts.json` | new |
| S9 | Experiments pool 20% of budget; revenue 30/30 reserve/draw split around the locked 40% reinvest | `org/finance.json` | A3 remainder |
| S10 | Meeting cost cap $1.50; Run cap `maxRunUsd` $0.50 (mid) / $2 (deep); daily cap $10 (locked) | `org/limits.json` | new |
| S11 | Daily LinkedIn draft at 08:30 local on weekdays, catch-up `once`; daily digest 07:30 | `org/schedules.json` | new |
| S12 | Private data uses Claude Max only via subscription; an Anthropic API key is **not** private-eligible (strict reading of C13) | `org/providers.json` `privateEligible` (owner-locked, risk-widening) | new |

---

## 26. Configuration as data (C17)

### 26.1 Principle
The engine repo ships **mechanisms** (fleetd, gateway, dispatcher, workflow engine, node executors, policy engine, connectors, UI) and **schemas**. Everything that describes *this* company is **data** in `$FLEET_HOME`: org, departments, teams, roles (prompts, tools, scopes, tiers), agents, workflows, schedules, connections, providers/routing, budgets, thresholds, autonomy, limits, data-class rules, skills selection, templates. The engine must start and work with an **empty** company. All starter content ships as templates under `engine/templates/` (data packages, section 26.6).

| Was hard-coded in v1.0 | Now |
|---|---|
| Full-life org table (8.4, C10) | template `org-full-life` |
| LinkedIn pipeline roles + flow (6.2, P1-10) | template `wf-learning-to-linkedin` + role templates `roles-content`, `roles-verification` |
| Task-type → tier table (4.7), failover chains (4.8) | `defaults-v1` → `org/routing.json`, `org/providers.json` |
| Thresholds, caps, autonomy defaults (7.4, 9, C11) | `defaults-v1` → `org/policy.json`, `org/limits.json` |
| S1-S12 | `defaults-v1` values |
| `privateAllowed()` engine constant | `privateEligible` owner-locked provider field |
| Schedules (12) | `org/schedules.json` / workflow trigger nodes |
| Channel modes (10.5) | per-Connection settings (28.3) |

### 26.2 Invariants that stay in code (mechanisms, not configurable off)
1. Governed state changes only through fleetd (gateway/REST). Agents can't write config, approvals, grants, audit, ledger or tasks.
2. **Effective permission = role scopes ∩ team ∩ department ∩ company policy ∩ grants.** Workflows, templates and grants can only narrow it. A grant is always ≤ the granter's authority.
3. Every `write_external` action needs a valid Approval bound to the exact payload hash, *or* a Connection posting mode that permits auto plus the auto-policy passing. Posting modes above `manual` are owner-only settings.
4. Verdicts and approvals are bound to hashes. Changing a payload invalidates them.
5. Secrets are never displayed, returned, logged or put in prompts. They're resolved only inside execution services.
6. Data-class taint propagates. Fail closed for private data when no eligible provider exists.
7. The kill switch, audit chain, budget hard caps and per-Run caps always apply.
8. Every config write is validated against its schema and semantic rules. Invalid config never becomes active.

### 26.3 Risk-widening changes (owner-only, re-auth, audited diff)
Raising autonomy. Posting mode above `manual`. Adding a `write_external` action to a workflow. Removing or weakening an approval/verify gate. Widening role scopes or native tools. Raising budgets, caps or thresholds. Enabling `privateEligible` on a provider. Adding a Connection or switching its auth mode. Installing a non-builtin connector. Importing a template that does any of the above. These need the Owner session + passkey/PIN re-auth. The confirmation screen shows the exact diff and a risk summary. Agents may only **propose** such changes (as a diff Task for Tej).

### 26.4 Persistence (UI and file edits)
- UI → `PUT /api/config/{kind}/{id}` with `expectedVersion` (optimistic concurrency) → Zod + semantic validation (section 27.3 for workflows) → risk classification (26.3) → `store.write` → **auto-commit** in the `$FLEET_HOME` git repo (`config(<kind>/<id>): v<n> by <actor>`) → `ConfigVersion` + audit event → WS `config.changed`.
- One file per object (`org/teams/<id>.json`, `workflows/<id>.json`...), with stable key ordering and pretty-printing for clean diffs.
- **History/undo:** every object has versions (git history + `ConfigVersion` index). The UI shows diffs and can **revert** (a revert is a new version, and widening reverts follow 26.3).
- **Hand edits:** a file watcher validates edits. Valid edits apply like UI edits (actor `file`, and a risk-widening hand edit is **held** as pending until Tej confirms in the UI). Invalid files are rejected, the last-good version stays active, and the UI shows the error with file:line.

### 26.5 How changes take effect on running work
| Change | Effect |
|---|---|
| Tightening (lower autonomy, caps, disable connection, pause schedule/team, kill) | **Immediate (hot)**. Running Runs that now violate policy are stopped at their next tool call. |
| Widening (26.3) | After owner confirmation, applies to **new** Runs/instances only |
| Role prompt/tools/tier, routing, providers | Next Run (the Brief and scope token are built at Run start) |
| Workflow edit | New instances use the new version. Running instances keep their **pinned** version. Optional "migrate at safe point" (only at `wait`/`approval` nodes, owner-confirmed, validated against instance state). |
| Schedule edit | Next scheduler tick |
| Connection settings | Next action execution (limits/quiet hours re-checked at execution) |

### 26.6 Templates (import/export)
- **Package:** a directory or `.zip` with `template.json` (`id, version, kinds[], requires: { schemaVersion, connectors[] }, params: JSON Schema, description`) plus data files with `{{param}}` placeholders.
- **Import:** pick → fill params (form from the param schema) → **preview diff** (create/update/conflict per object) → resolve conflicts (rename / merge / skip) → validate everything as a dry run → apply as one change set (one commit, one undo). Risk-widening content goes through 26.3.
- **Export:** select objects → bundle. Secrets, secret values, browser profiles, account handles (off by default), private-class data and run history are **never** exported. Secret *refs* become placeholders.
- **Shipped templates (Phase 1):** `defaults-v1`, `org-full-life`, `roles-content`, `roles-verification`, `wf-learning-to-linkedin`, `team-youtube-channel` (manual connection by default).

---

## 27. Workflow engine and visual builder (C19)

### 27.1 Model
`Workflow` (versioned graph) → `WorkflowInstance` (pinned version, trigger payload, node states) → node executions. **Agent-type nodes compile to Tasks + Runs** through the normal dispatcher (routing, failover, data-class, 35% handoff/restart, scorecards). Approval nodes compile to Approvals. Action nodes go to execution services via Connections. Instance state is durable (`workflows/instances/<id>/state.json` + an events chain), so an instance resumes after a restart.

### 27.2 Node types (Phase 1 set)
| Type | Purpose | Key config |
|---|---|---|
| `trigger.schedule` / `trigger.manual` / `trigger.event` / `trigger.webhook` | Start an instance | cron + tz + catchUp; button; event type filter (e.g. `brain.intake`); webhook (local path + HMAC secret ref, Tailscale-only) |
| `agent` | One agent step = one Task | `roleId` (or team member), `tierOverride` (≤ role max), `briefTemplate` (inputs by reference), `acceptance[]`, `doneCondition`, `outputSchema`, `maxUsd` |
| `verify` | Fresh verifier Run on a Proposal | verifier role, rubric/skill, hidden tests ref |
| `judge` | Cross-family grading | rubric, `familyPolicy: other_than_implementer` |
| `approval` | Owner/delegated gate | approver (`owner` / role), payload ref, expiry, postpone allowed |
| `action` | Connector action through a Connection | `connectionId`, `actionId`, input bindings. `effect` comes from the manifest |
| `branch` | Condition | **JSON Logic** expression over bound data (data-only, no code execution) |
| `fanout` / `fanin` | Parallel branches | fan-out over a list or N branches; fan-in `all` / `any` / `n_of` |
| `loop` | Repeat | `forEach` or `until` (JSON Logic) with required `maxIterations` and `maxUsd` |
| `wait` | Delay | duration / until time / until event, with timeout |
| `notify` | Push/digest | builtin `notify` connector (ntfy) |
| `set` | Map data | JSON Logic mapping into a typed output |
| `subworkflow` | Call another workflow | `workflowId@version`, param bindings. Inherits the caller's narrowed scope |

Data passes along typed edges. Node inputs bind with references like `{"$ref": "nodes.draft.output.contentHash"}`, checked at save time against each node's `outputSchema`.

### 27.3 Validation (save time, in fleetd; inline errors in the UI)
1. **Schema:** every node config is valid against its node-type schema.
2. **Graph:** at least one trigger, every node reachable, no cycles except through `loop` nodes, fan-in matches fan-out, every terminal path ends.
3. **Types:** every binding resolves, and the producer's output schema is compatible with the consumer's input schema.
4. **References:** roles, agents, teams, connections, sub-workflows (pinned versions) and connector actions all exist and are active.
5. **Scope check:** each agent node's role has the tools/scopes the node needs. `tierOverride` ≤ the role's max tier. Actions use only Connections bound to the workflow's team (or ones explicitly shared with it). Sub-workflows can't widen scope.
6. **Data-class taint:** a node's output class is the max of its inputs. Private-tainted data can't flow into a node whose role, provider chain or connection isn't private-eligible, and never into a `write_external` action unless the Connection is private-allowed (default: none).
7. **Gate rule:** every path from a trigger to a `write_external` action must pass a `verify` node and an `approval` node bound to the same payload hash, **unless** the Connection's posting mode permits auto (owner-set). The validator computes this per path.
8. **Budget:** estimated cost per instance (from node `maxUsd` + historical medians) ≤ the team envelope and daily cap share. Loops and fan-outs need explicit caps.
9. **Classification:** the diff against the previous version is classified (internal vs risk-widening, 26.3).

### 27.4 Permission boundary (precise)
- **Who edits:** only the Owner session saves workflows. Agents (Directors, CoS) may submit a *proposed* workflow version, stored as a draft and shown to Tej as a diff Approval.
- **What a workflow can do:** nothing its nodes' roles, team and connections couldn't already do. The workflow engine runs with **no authority of its own**. Each node runs under a scope token = the role's effective scope (26.2.2) ∩ the node's optional narrowing. The engine itself only creates Tasks/Approvals and calls execution services with approval tokens it can't forge (signed by the policy engine after checks).
- **External-facing edits:** any change that adds, removes or reconfigures an `action` with `effect: write_external`, an `approval`/`verify` gate on such a path, a trigger of type `webhook`, or a binding into an external action's payload is risk-widening. It needs owner re-auth and is audited with the full diff.
- **Runtime guard:** even with a valid saved workflow, the action executor re-checks (at execution time) the approval/verdict hash, the connection mode, limits, quiet hours, the kill switch and budget. Saved structure is never trusted alone.

### 27.5 Execution semantics
Deterministic state machine in fleetd. One worker per instance step. **Idempotency key** per node execution (`instanceId:nodeId:iteration`), so a restart never double-posts. Per-node retry policy (default 2, exponential backoff), and failure routes to an optional `onError` edge, else the instance becomes `failed` with a notification. The kill switch pauses all instances (`paused_killed`) and resume restarts from the last completed node. Instance and node states appear on the kanban (Tasks) and in the builder overlay.

### 27.6 Dry-run and simulation
- **Validate + estimate:** static checks plus a cost/time estimate.
- **Simulate:** runs the graph with `sim: true`. Agent nodes return outputs from a chosen fixture (a recorded past run, or hand-entered sample output). Approvals can be auto-answered by the simulator. Actions write to a sandbox log only (the gateway and execution services **reject** any real action for `sim` instances). Simulation produces a normal event stream, so the builder overlay and the office replay show exactly what would happen. No spend, no external effects.

### 27.7 Builder UI
- **Canvas library: @xyflow/react (React Flow).** MIT-licensed, mature, custom node components, minimap, fits the React stack. Alternatives: Rete.js (heavier plugin model), a custom PixiJS canvas (too much effort; Pixi stays for the office).
- Palette of node types (generated from node-type schemas + installed connector actions). The inspector form is rendered from the node's JSON Schema (`@rjsf/core` with custom widgets for role/connection/ref pickers and a cron builder).
- Live validation badges per node/edge, a "Simulate" button, a run-history picker with overlay (status color, duration, cost, attempts per node), version history with visual diff, and a "Save" that opens the 26.3 confirmation when risk-widening.
- Works on desktop. Phone shows read-only view + run overlay.

### 27.8 Template `wf-learning-to-linkedin` (the C15 slice as data)
`trigger.event(brain.intake, source=owner)` → `agent(Curator: compile to wiki with evidence)` → `wait(until next weekday 08:30, or trigger.schedule join)` → `agent(Writer: draft 2 variants; outputSchema {text, variants, claims[]})` → `agent(Editor: voice check)` → `verify(Verifier: claims↔facts, rubric linkedin-voice)` → `judge(other family; skipped with weak flag if unavailable)` → `branch(verdict.pass)` → **true:** `approval(owner, payload=contentHash)` → `action(connection: linkedin-personal [manual connector], actionId: post.manual)` → waits for the "posted" URL → `notify(done)`. **false:** loop back to the Writer with findings (`loop maxIterations 2`) → then `notify(needs attention)`.

---

## 28. Teams, connections and the connector framework (C18)

### 28.1 Team
A Team lives in a Department: one Manager agent, member agents created from Role templates, its Connections, its Workflows, an envelope, and an autonomy override ≤ the Department's. Example: "YouTube: Main channel" team bound to one YouTube channel. A second channel = a second team (or a second connection on the same team if Tej wants one team to run both).

### 28.2 Create-team wizard (UI)
1. Pick a Department (or create one).
2. Pick a team template (e.g. `team-youtube-channel`) or start blank.
3. Choose role templates for the Manager and members, name them, set tiers (≤ role max) and budget.
4. **Attach connections:** choose a connector (platform) → choose auth mode (api / browser / manual) → fill the manifest-rendered form → for API, pick Infisical secret refs; for browser, run "Log in now" → posting mode (default `manual`) → daily limits, quiet hours → ToS risk acknowledgement.
5. Pick workflows from templates (bound to this team's connections) or open the builder.
6. Review: a diff of everything created, with risk-widening items highlighted. Owner confirms (26.3), then the change is applied as one change set.

### 28.3 Connection rules
- Exactly one external account per Connection and exactly one owning Team. Several Connections per platform are allowed.
- Each Connection has its own auth mode, posting mode (`manual` / `approve_then_auto` / `auto_when_unavailable` / `auto`), daily limit, quiet hours, ToS badge and health status (`ok` / `needs_login` / `rate_limited` / `error` / `disabled`).
- Actions on a Connection only run inside its Team's workflows (or workflows the Team explicitly shares it with).

### 28.4 Auth mode `api` (Infisical)
- The Connection stores **refs only**: `{ project, environment, path, keys[] }` + which execution service identity reads them (e.g. `publisherd`). The UI shows refs plus "exists ✓ / last rotated <date>", never values. There is no "reveal" button anywhere.
- Ref validation: the execution service checks the refs exist through Infisical's API using its own identity. The result (exists / missing / forbidden) goes back to fleetd, never the value.
- Injection happens at execution time inside the execution service (11.4). For OAuth platforms (YouTube Data API, LinkedIn), the refresh token lives in Infisical. The connector's OAuth helper runs the consent flow in a headed window, writes tokens directly to Infisical via the service identity, and fleetd never sees them.

### 28.5 Auth mode `browser`
**Tooling decision: Playwright persistent context** (`launchPersistentContext`, Chromium), one profile per Connection.
| Option | Verdict |
|---|---|
| **Playwright persistent context** | **Chosen.** Mature, scriptable, persistent profiles, accessibility snapshots for element refs, tracing/screenshots for evidence, headed login. Runs inside publisherd. If Bun's Playwright support is incomplete, publisherd's browser worker runs on Node LTS (A37). |
| Puppeteer | Viable, but Chrome-only and a weaker locator/trace story. |
| LLM-native frameworks (Browser Use, Stagehand) | Not as the base. They may be added later as *drivers* inside the same sandbox, but they add injection surface. |
| Tej's real Chrome via an extension (e.g. Claude in Chrome) | **Rejected:** shares his main profile and every logged-in site, so there's no credential boundary (the poteto anti-pattern). |
| Cloud browsers | Rejected for now: sessions and cookies leave the machine. |

**How the agent drives it, under policy:**
- The browser agent's Run gets **only** `browser.*` gateway tools + `evidence.attach` + `handoff.write`. No file write, shell, web search, brain write or other connections (capability separation).
- `browser.*` is proxied by publisherd. The agent never touches CDP, cookies or the profile: `browser.open(connectionId)`, `browser.snapshot()` (accessibility tree + visible text, **wrapped as untrusted**), `browser.click(ref)`, `browser.type(ref, text | {$ref: payload field})`, `browser.upload(stagedFileRef)`, `browser.screenshot()`, `browser.submit(ref)`.
- `browser.submit` (the final Post/Publish/Send click) is allowed only with a valid approval token for the payload hash (or connection auto-policy). Typed text must match the approved payload (publisherd compares hashes of the text it types against the approved payload, so the agent can't alter content).
- A navigation allow-list comes from the connector manifest `netDomains`. There's a step cap (default 40), per-step audit (action + ref, no cookies), and screenshot evidence at submit.
- **Session health:** a scheduled probe (connector-defined logged-in check) runs every 6h and before every action. On failure: `needs_login` → notify Tej → `fleet connection login <id>` or the UI button opens a **headed** window (locally, or noVNC over Tailscale on the VPS). 2FA/CAPTCHA are always handed to Tej, never solved by the agent.
- Profiles are age-encrypted at rest, decrypted to a `0700` temp dir only while in use, owned by `fleet-pub`, never exported or backed up in plaintext. `forget` securely deletes the profile.

**Threat model (browser):**
| Threat | Control |
|---|---|
| Cookie/session theft | Profile owned by a separate OS user, encrypted at rest; the agent has no filesystem/CDP access; no cookies in logs or evidence |
| Shared profile across teams | One profile per Connection; no reuse; publisherd refuses a profileId bound to another Connection |
| Prompt injection from page content | Snapshot text wrapped untrusted; the browser Run has no other tools; submit needs an approval hash match; typed content must equal the approved payload; domain allow-list |
| ToS violation / account ban | Per-connection ToS badge + acknowledgement, daily limits, quiet hours, human-like pacing; Tej's call (C6) |
| Account lockout / security challenge | Stop on challenge detection, mark `needs_login`, notify Tej; never retry logins automatically |
| Exfiltration via typed fields | `browser.type` only accepts payload refs or short literals ≤ 200 chars matching a policy; no reading of other tabs |

### 28.6 Auth mode `manual`
The action produces a "do this yourself" card (copy text, download asset, open URL) in the approvals inbox. Tej marks it done with a URL. No credentials, no automation. This is the default for every new Connection and the only mode Phase 1 executes.

### 28.7 Connector framework
- **Manifest** (JSON, schema in PHASE-1-PLAN section 3): `id, version, platform, description, authModes, configSchema, requiredSecrets (per auth mode), actions[] { id, title, effect, inputSchema, outputSchema, authModes, rateLimit }, healthCheck, rateLimits, tosRisk per auth mode, netDomains, trust`.
- **Implementation module:** `export default { manifest, actions: { [id]: (ctx, input) => output }, health(ctx), oauth?(ctx) }`. `ctx` gives the resolved config, a secret accessor (only the manifest-declared fields, only inside execution services), an HTTP client restricted to `netDomains`, a browser handle (browser mode), evidence/screenshot helpers and a logger with redaction.
- The UI renders connection forms, action inputs in the builder, and ToS badges from the manifest. **Adding a platform = adding a connector**, with no engine changes.

### 28.8 Connector trust model
- **Builtin** (in the engine repo, reviewed, CI-tested, contract tests against recorded fixtures) are the only ones loaded in Phase 1.
- **Third-party (Phase 4+):** installed into `$FLEET_HOME/connectors/<id>@<version>/`, pinned by content hash, signature verified (minisign/sigstore key list in config), owner-confirmed install (risk-widening). They run as **separate subprocesses** under the execution service's OS user, with a scrubbed env, a temp working dir only, network only via publisherd's egress proxy restricted to the manifest's `netDomains`, and secrets passed per call for declared fields only. A crash or timeout kills only the subprocess.
- Connector code never runs inside fleetd or agent processes.

### 28.9 Phase 1 connector set
- `builtin/manual`: actions `post.manual`, `upload.manual`, `task.manual` for any platform. Executes in Phase 1.
- `builtin/brain` (intake/read for triggers and agent nodes) and `builtin/notify` (ntfy). Internal, no external effect except push.
- `linkedin` and `youtube` **manifests** (actions such as `post.create`, `video.upload`, `video.update_metadata`, `analytics.read`, with auth modes api/browser/manual) with `status: planned`. Connections can be created now in `manual` mode and switched to api/browser when Phase 4 implements those actions.

---

## 29. Assumptions added in v1.1
| ID | Assumption | Status |
|---|---|---|
| A37 | Playwright may need Node LTS for publisherd's browser worker if Bun support is incomplete | verify in Phase 4 |
| A38 | JSON Logic is expressive enough for branch/loop/set nodes | [safe default] |
| A39 | @xyflow/react + @rjsf/core for the builder and schema-driven forms | [safe default] |
| A40 | Only the Owner session saves config. Agents propose diffs. | [safe default] |
