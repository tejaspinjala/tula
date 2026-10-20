# Guildhall

Guildhall is a governed agent-operations platform played as a pixel-art guild game: a Guild Master runs a guild of AI agents organised into Halls. These names are binding in UI, agent names, prompts and docs; code uses plain names through a configurable glossary.

## The guild

**Guild Master**:
The human who owns a guild. Never an agent.
_Avoid_: owner, user, CEO

**Guild**:
One tenant: a Guild Master's organisation of Halls, agents, Treasury and Archive.
_Avoid_: company, workspace, org

**Steward**:
The chief-of-staff agent that takes the Guild Master's goals, splits them and routes them to Officers.
_Avoid_: assistant, CoS

**Hall**:
A department of the guild covering one life or work area, with a themed name (e.g. the Alchemists for Engineering).
_Avoid_: department, team

**Officer**:
The agent directing one Hall. Also called Hall Warden.
_Avoid_: director

**Captain**:
The agent managing one Campaign.
_Avoid_: manager

**Member**:
A worker agent with a rank (Apprentice, Journeyman, Adept) that maps to a model tier (cheap, mid, deep).
_Avoid_: employee, bot

## Work

**Quest**:
One unit of work with exactly one owner and a done-condition.
_Avoid_: task, ticket

**Sub-Quest**:
A Quest a Member spawns while working another Quest (its parent), run by its own worker and reported back to the parent. Bounded by the guild's `maxChildrenPerQuest` and `maxSpawnDepth`; it inherits its parent's data class.
_Avoid_: subtask, child task

**Campaign**:
A project: a set of related Quests under one Captain.
_Avoid_: project

**Workflow**:
A saved, versioned graph of steps (trigger, agent, verify, approval, post) that compiles to governed Quests. It has no authority of its own: every Quest it posts goes through the normal dispatcher, Verdict, Seal, caps and Bar the Gates.
_Avoid_: pipeline, automation

**Workflow instance**:
One run of a pinned Workflow version. Its Quests share one Campaign, the instance id.
_Avoid_: job

**Quest Board**:
The kanban of a Hall's Quests.
_Avoid_: backlog

**Missive**:
A small typed message on the quest bus carrying ids and hashes, never large content.
_Avoid_: message, notification

**Inquiry**:
One precise question from one Hall to another, answered once and filed in the Archive.
_Avoid_: chat, ping

**Dossier**:
A code-generated, verified handoff packet about something a Hall produced.
_Avoid_: summary, report

**Bug Report**:
A defect found by any Hall, filed with a reproduction; it becomes a **Fix Quest** on the owning Hall's Quest Board.
_Avoid_: issue

**Brief**:
The compact instructions compiled by code for one agent run: the Quest, its done-condition and pointers to the exact files, artifacts and skill sections it needs.
_Avoid_: prompt, context dump

**Handoff**:
The schema-checked packet an agent run ends with: goal, done-condition, evidence, open items and artifact references.
_Avoid_: summary, status update

**Proposal**:
The exact content or commit, identified by its hash, that a Quest wants to send outside the guild or merge; it is what a Verdict and a Seal are bound to.
_Avoid_: draft, change

**Rite**:
A versioned workflow graph.
_Avoid_: workflow, pipeline

**Envoy**:
A connection to an outside account (API, browser or manual).
_Avoid_: integration

**Charter**:
An importable, exportable guild template with secrets and private data stripped.
_Avoid_: template

## Governance

**Seal**:
The Guild Master's approval: single-use, expiring, bound to the exact action.
_Avoid_: approval, sign-off

**Seal Policy**:
The configurable rules for what needs a Seal and what agents may do alone.
_Avoid_: permissions, autonomy settings

**Verdict**:
A structured review result bound to a content hash.
_Avoid_: review result

**Council of Elders**:
The review and decision council (architect, skeptic, security, ops, user voices).
_Avoid_: committee

**Petition** / **Writ**:
A request for access / a grant of access that never exceeds the granter's own authority.
_Avoid_: ticket, permission request

**Bar the Gates**:
The kill switch, per guild or global.
_Avoid_: stop button

**The Watch**:
Security, shared across all Halls.
_Avoid_: SecOps

## Resources and memory

**Treasury** / **Treasurer**:
The guild's money (paper or real) / the agent that approves spends within its limits.
_Avoid_: wallet, bank

**Archive** / **Archivist**:
The guild's brain of linked notes, verified facts kept apart from quarantined assumptions / the agent that keeps it tidy.
_Avoid_: wiki, knowledge base

**Renown** / **Crowns**:
Experience points / building currency, earned only from verified progress and never mixed with Treasury money.
_Avoid_: coins, points

**Ledger of Deeds**:
Per-agent scorecards and metrics.
_Avoid_: analytics

## Loops

**Build Loop**:
How Guildhall itself gets built: a lead session briefs bounded workers, each ticket ends verify → run-check → review until no blocking findings.
_Avoid_: loop, dev loop

**Core Loop**:
The Guild Master's daily product cycle proven in Milestone 1: learning → verified draft → Seal → manual post.
_Avoid_: loop, main loop

**Agent Loop**:
Guildhall's own runtime that drives open or API models (the third adapter beside Claude Code and Codex).
_Avoid_: loop, fleet-loop

## Identity events

Event types the Guild Master's identity actions append to the guild's chained event log (ids only, never secrets):

**identity.founding_token_issued** / **identity.founding_token_spent**:
The guild's single-use founding token was issued with the guild / spent registering its first passkey.

**identity.passkey_registered**:
A passkey was added to the guild (payload: credential id).

**identity.signed_in**:
A passkey sign-in opened a session (payload: session id).

**identity.reauthenticated**:
A session re-authenticated with its passkey and received a short-lived proof (payload: session id).

## Archive and config events

Event types the Archive and the guild's config append to the chained event log (ids and small facts only, never note bodies or config content):

**note.added** / **note.edited**:
A note was added to the Archive (version 1) / a new note version was written (payload: note id, version, kind).

**learning.accepted** / **learning.dismissed**:
The Guild Master accepted or dismissed a suggested learning (payload: suggestion id and a keyed hash of its source id only, never its text, repo name or ADR title).

**config.seeded**:
The guild's first config version was seeded at founding (payload: version).

**config.version_proposed**:
A config version was proposed (payload: version, status `pending` or `applied`, kind, change). A widening change stays `pending` until confirmed.

**config.version_confirmed**:
A pending config version was confirmed and took force (payload: version).

## Workflow events

Event types the Workflow store appends to the chained event log (ids and small facts only, never the graph):

**workflow.version_saved**:
A Workflow version was saved (payload: workflow id, version, status `pending` or `active`, kind `internal` or `widening`). A widening version stays `pending` until confirmed.

**workflow.version_confirmed**:
A pending Workflow version was confirmed and may run (payload: workflow id, version).

**workflow.run_started**:
A Workflow instance was created (payload: instance id, workflow id, version).

## Gates, work and vault events

Event types appended to the chained event log by Bar the Gates and by the Quest, Hall and Vault stores (ids and small facts only, never content or secrets):

**gates.barred** / **gates.lifted**:
The Gates were barred / lifted (payload: bar id, scope `guild` or `global`, and the acting member id in the acting guild's own chain only). A global bar or lift is also told to every other guild's chain with the bar id and scope only, never who acted.

**quest.spawned**:
A Quest spawned a Sub-Quest (payload: parent quest id, child quest id, depth; ids and a number only, never the brief).

**handoff.recorded**:
A Quest attempt recorded its handoff (payload: quest id, attempt, handoff hash).

**artifact.stored** / **artifact.attached**:
An artifact was stored (payload: hash, class, size) / attached to a Quest (payload: quest id, hash).

**proposal.created** / **verdict.recorded**:
A Proposal was created (payload: proposal id, quest id, proposal hash) / its verdict was recorded (payload: proposal id, proposal hash, passed).

**hall.paused** / **hall.resumed**:
A Tripwire paused a Hall (payload: pause id, hall id, tripwire) / the pause was lifted (payload: pause id, hall id).

**steward.cap_reached**:
The Steward's daily cap was reached (payload: day, reason).

**vault.secret_added**:
A secret was added to the Vault (payload: its ref only, never the value).
