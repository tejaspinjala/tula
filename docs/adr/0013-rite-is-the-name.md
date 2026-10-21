# Rite is the one name for a saved, versioned graph of steps; the old word survives only where it is stored

The glossary defined both **Workflow** (a saved, versioned graph that compiles to governed Quests) and **Rite** (a versioned workflow graph), and the code, routes and UI said Workflow. Two words for one thing made the code disagree with the game. This settles it: **Rite is the name, and Rite run (not Workflow instance) is one run of a pinned Rite version.** The glossary's Workflow and Workflow instance entries are gone; Rite absorbed the Workflow definition and now lists workflow, pipeline and automation as words to avoid.

**Code and routes rename with no alias.** The guildd modules, port (`RiteStore`), adapters, types and functions, and the web panel, router entry, Bag entry and copy, all say Rite. The routes are `/guilds/:id/rites`; the old `/guilds/:id/workflows` path returns 404 rather than redirecting, because nothing outside this repo depends on it.

**What is stored keeps its name.** SQL tables and columns (`workflow_versions`, `workflow_instances`, `workflow_id`), migrations already on `develop`, and the persisted event types (`workflow.version_saved`, `workflow.version_confirmed`, `workflow.run_started`) are kept exactly as written: the event log is hash-chained, and renaming a stored type would break replay of old history. These are the only allowed uses of the old word in `apps/guildd/src` and `apps/web/src`. The event types are spelled once, as named constants (`RITE_EVENT`, `RITE_EVENT_PREFIX`) in each app's `rites/events.ts`, and referenced from there.

**Event payloads.** New events carry the Rite id under `riteId`; events already in the log keep `workflowId`, and nothing reads that key back.

We rejected keeping Workflow as the engineering word beside Rite as the game word (it is the split that made this ticket necessary), and renaming the stored tables and event types too (a data migration and a chain break for a name no reader sees).

Amends ADR-0009.
