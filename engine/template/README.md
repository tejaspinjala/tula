# engine/template: template import/export + starter data (P0-7)

Tests: `tests/unit/templates/*.test.ts` (temp dirs only). Starter data: `engine/templates/<id>/` (JSON only, no code). CLI: `bun run template ...` (`engine/cli/template.ts`).

## Format
`engine/templates/<id>/template.json` is validated by `engine/schema/template.ts` (`id, version, title, description, kinds[], requires{schemaVersion, connectors[], templates[]}, params, files[{kind,path}]`). Each file holds ONE object of a registered config kind (`engine/home/kinds.ts`): a dir kind's file is one object whose `id` names it (`org/<kind>s/<id>.json` in the home), a file kind (`providers`, `routing`, `policy`, `limits`) is the whole file. `params` is a JSON Schema subset: property `type` string/number/integer/boolean, `default`, `enum`, `pattern`, `minLength/maxLength`, `minimum/maximum`, `required`. `{{name}}` is replaced in string VALUES (a string that is exactly `{{name}}` keeps the param's type); `{{name|slug}}` slugifies. An undeclared or unresolved placeholder is an error.

## Import (`import.ts`)
`fleet template import <ids|dirs...> --preview|--apply [--home] [--param k=v | tpl:k=v] [--answers f.json] [--templates-dir D] [--resolve kind/id=skip|overwrite] [--on-conflict skip|overwrite]`.
- Plan: every object is parsed with its kind's schema and semantic check (so the `providers` private-eligible gate applies to templates too), references between objects are checked on (home + plan) (`REFS` table), and each object is diffed against the home: `added | changed | unchanged | conflict | skipped`.
- An existing, different object is `changed` only if it still equals what THIS template installed last time (hash in `templates/installed/<id>.json`); otherwise it is a `conflict` (edited since, or never installed by this template).
- Apply refuses while a conflict is unresolved or the plan has errors. It writes through `store.write` under a lock, re-validates the whole home with the P0-6 registry, and makes ONE commit of exactly the written files (plus `.gitignore` the first time). Any failure (write, registry rejection, commit) restores every file. A neutral `fleet <fleet@localhost>` identity is used when git has none.
- Idempotent: an identical re-import is `no changes` and makes no commit.
Not guaranteed: `requires.connectors` and `schemaVersion` are not checked (no connector registry yet); risk-widening review (SPEC 26.3, owner re-auth) is not enforced here, only the per-kind checks are; rollback restores files, not the `.gitignore` or dirs `initHome` created.

## Export (`export.ts`)
`fleet template export <id> --out DIR [--kind K] [--only kind/id]`. Never exports `company`. Connections keep only `id, teamId, connector, account.displayName + owner, auth.mode, posting (mode forced to manual), status: pending_confirmation`: secret refs, handles, urls, profile ids, `config` (channel ids), health are dropped. Providers lose `secretRef`; agents lose `coachingNoteIds, projectId`. Any string that looks like a credential (same detectors as the schemas) becomes `<redacted>` and is reported. Config files whose real path is under `private/`, `exec/` or `brain/private/` (e.g. a symlink) are skipped.

## company.example
`company.example/` is the starter templates (`engine/templates/company-example.json`) imported into a fresh home, minus `.git`/`.gitignore`/`state`. `bun run example:build` rewrites it; `bun run example:build -- --check` and `tests/unit/templates/generate.test.ts` verify it equals a fresh import. `bun run sync` generates `.claude/agents/` from it with `engine/adapters/claude-code/generate.ts`.
