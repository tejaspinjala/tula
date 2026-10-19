# engine/schema

Does: defines every Phase 1 data contract as a Zod 4 schema (one file per entity, canonical), and generates `index.ts` (a registry of all entity schemas) plus `json/<entity>.schema.json` (JSON Schema 2020-12) from them.

Proof:
- 29 entity modules + 1 library (`common.ts`); the registry is `schemas` in the generated `index.ts`, and `tests/unit/schema/export.test.ts` "one module per entity" checks that every module is registered.
- Every entity has >= 2 valid and >= 2 invalid fixtures under `tests/fixtures/schema/<entity>/`: `fixtures.test.ts` "every entity has >= 2 valid and >= 2 invalid fixtures".
- Every valid fixture parses and every invalid fixture fails with a Zod issue at its `_path` (the rule is named in `_why`): `fixtures.test.ts` "schema <entity>".
- `workflow/valid-every-node-type.json` uses all 17 node types: `fixtures.test.ts` "a valid workflow fixture uses every node type".
- Committed generated files equal a fresh export: `export.test.ts` "committed index.ts and json/*.schema.json match a fresh in-memory export"; the CLI exit code: "the CLI exits 0 on a clean tree and 2 on an unknown flag".
- Valid fixtures also validate against the exported JSON Schema (round-trip) using the test-only validator `tests/unit/schema/mini-json-schema.ts`, which throws on any keyword it does not implement: `export.test.ts` "round-trip".
- PHASE-1-PLAN section 3 and the export have the same property names and required sets at every nested inline object and `$defs` entry, except the divergences listed below: `plan-sync.test.ts`.
- The plan's example `youtube` manifest is a valid ConnectorManifest: `plan-sync.test.ts` "the plan's example youtube manifest...".

Interface:
- `import { schemas, taskSchema, type Task, ... } from 'engine/schema/index.ts'`. Each entity module exports `<camelName>Schema` and its inferred type. `schemas: Record<string, ZodType>` is keyed by entity name (= file name).
- `bun run schema:export` writes `index.ts` and `json/*.schema.json` and deletes json files no module generates. `bun run schema:export --check` writes nothing, prints one line per out-of-date file, exits 1 if any (2 on an unknown argument). Do not edit `index.ts` or `json/` by hand.
- Adding an entity: create `<name>.ts` exporting `<camelName>Schema`, run `bun run schema:export`, add fixtures. A module exporting neither `<camelName>Schema` nor `<camelName>Defs` makes the export throw.
- JSON Schema is exported with `io: 'input'`: fields with a Zod `.default()` are optional and carry `default`. Shared schemas with `.meta({ id })` appear as `$defs/<id>` inside each file (no cross-file `$ref`).
- Objects are strict (`z.strictObject`): unknown keys are rejected, exported as `additionalProperties: false`.

Entities: common (library: id, slug, ts, tier, dataClass, sha256, usd, autonomy, authMode, postingMode, tosRisk, jsonSchema, scope, evidenceRef, doneCondition), task, run, handoff, spend-request, approval, access-grant, access-request, event, scorecard, verdict, workflow, node-types (one workflow node: discriminated union on `type`, per-type config schemas as `$defs/<type>`), workflow-instance, team, connection, connector-manifest, template, config-version, and the config kinds company, department, role, agent, providers, routing, policy, limits, schedule, goal, portfolio.

What Zod checks beyond types (refinements; these are not in the exported JSON Schema):
- Workflow: unique node ids and edge ids, edge endpoints exist, at least one trigger node. Node configs: `fanout` exactly one of `over`/`branches`, `fanin` `n` iff `n_of`, `loop` needs `forEach` or `until`, `wait` needs one wait condition.
- Not checked here (workflow validator, slice P1-W1, SPEC 27.3): reachability, cycles, which ports a node type may emit, binding resolution and type compatibility, references to roles/teams/connections, scopes, data-class taint, the gate rule, budgets, risk classification.
- Connection: secret references only. Each ref field (`field`, `project`, `environment`, `path`, `key`) has a strict name format and rejects secret material (`containsSecretValue`: known credential prefixes, PEM, JWT, `key=value`; `looksLikeOpaqueToken`: a >= 20-char unbroken mixed letter/digit word). Every other string in the connection is scanned with `containsSecretValue`. `secretRefs` only in `api` mode (and then `identity` is required), `profileId` only in `browser` mode. `trigger.webhook.hmacSecretRef` and `providers.*.secretRef` use the same ref check.
- Owner-locked field: `providers.<id>.privateEligible` is required, annotated `x-ownerLocked: true` in `providers.schema.json`, and listed in `OWNER_LOCKED_FIELDS`. A provider with `private` in `dataClasses` needs `privateEligible: true`; `secret` is never an allowed provider class. Who may change it, re-auth and audit are enforced by the config service (P1-C) and loader (P0-6), not here.
- Event: `data` is checked per type for the v1.1 event types (`EVENT_DATA_SCHEMAS`); workflow events need `workflowInstanceId`, `workflow.node.state` needs `nodeId`.
- Other record-consistency rules: task blocked ⇒ `blockedReason`; approval consumed ⇒ `usesLeft: 0`, `decidedBy ≠ requestedBy`; handoff `met` ⇒ evidence; verdict `pass` ⇒ no blocker finding; config-version widening ⇒ reasons, active widening ⇒ `confirmedAt`; role `tier ≤ maxTier`; portfolio shares ≤ 1 and floor ≤ share; template file kinds declared in `kinds`, paths relative.

Id format: `ID_RE` in `common.ts` is `<prefix>_<26 Crockford base32>`, the format `newId()` in `engine/lib/ids.ts` (slice P0-3) produces. The schema package does not import engine/lib, so the regex is duplicated. Consistency is checked by `tests/unit/schema/ids-consistency.test.ts`: when `engine/lib/ids.ts` exists (after P0-3 merges), it generates ids for several prefixes and timestamps and asserts each matches `ID_RE`; before that it passes trivially.

## Divergences from PHASE-1-PLAN section 3
Each one is asserted in `tests/unit/schema/plan-sync.test.ts` (`DEF_RENAMES`, `DECLARED_DIVERGENCES`) or is a value-level constraint the property-name comparison does not see.
1. `common#/$defs/ulid` is renamed `id` and its pattern is `ID_RE` (`<prefix>_<ULID-like>`), not a bare ULID: the id helper from P0-3 emits prefixed ids.
2. `workflow#/$defs/nodeType` is not emitted: a node is a discriminated union, so each variant has a literal `type` and the per-type config is checked by Zod directly (the plan has `config: object` + "the validator applies `$defs[node.type]`"). The enum exists in Zod as `NODE_TYPES`/`nodeType`.
3. `binding` is exported as `anyOf` (plan: `oneOf`). The two branches are strict objects with disjoint required keys, so the accepted set is the same.
4. Extra `$defs` in common: `slug`, `autonomy` (L0-L3; L4 is reserved by SPEC 9 and rejected everywhere), `authMode`, `postingMode`, `tosRisk`, `jsonSchema`.
5. Stricter than the plan (same property names): nested objects are strict (plan leaves some open, e.g. `task.proposal`, `run.error`); refs to config objects use the `slug` pattern; `connectorManifest.version`/`template.version` are semver; `connector-manifest.requiredSecrets`/`tosRisk` keys are limited to auth modes; `node.position` and other plan objects without `required` keep all fields optional.
6. `access-request` (no plan block; the plan describes it as the grant shape minus `grantedBy`) also drops `requestId` and `granterAuthorityHash`, and adds `grantId`.
7. No plan block exists for company, department, role, agent, providers, routing, policy, limits, schedule, goal, portfolio: their fields come from SPEC sections 4.7, 4.8, 5, 7.4, 8, 9 and 25. Role uses one `scope` object (SPEC 5 lists `readScopes`/`writeScopes`) and adds `maxTier` (needed for SPEC 27.3 item 5). Config objects carry no `createdAt`/`updatedAt`/`version` (SPEC 5 says every entity has them); versions live in ConfigVersion, matching the plan's Team/Connection blocks.
8. SPEC 5 `Channel` and the `org/accounts.json` "Account" have no schema of their own: v1.1 replaces them with Connection (`account`, `auth`, `posting`).
9. No per-entity `schemaVersion` literal: the plan defines none (only `template.requires.schemaVersion`, a string).

Unverified:
- `mini-json-schema.ts` implements only the keyword subset used by the export; it is not a conformance-tested JSON Schema validator.
- Secret detection is pattern-based; a credential format not covered by the patterns and shorter than the opaque-token threshold passes. Runtime redaction (SPEC 11.3) is a separate layer.
- `ID_RE` agreement with `engine/lib/ids.ts` was checked against the P0-3 branch as of 2026-10-18 by hand; the automated check activates only once that file is on this branch.
