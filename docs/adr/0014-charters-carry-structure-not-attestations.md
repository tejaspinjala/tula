# Charters carry structure, not attestations; importing one never grants authority

A **Charter** is a guild template a Guild Master can export and import. It is only useful if sharing one is safe, so this settles what travels and what an import may do.

**A Charter carries structure.** Halls, Members, Captains, Seal Policy, caps, providers, routing profiles, schedules, Tripwires, the Treasury envelope, the content policy, and the active version of each live Rite. It never carries an attestation or private data: `privateEligible` on every Hall and provider is exported as `false`, `learningRepos` is dropped, and Rites that are archived, have no active version, or touch a `private` Hall are left out. Every removal is listed in the Charter's `omitted` array, so the loss is visible. Every config key is classified `structure` or `local` in one table, and a test fails when the schema gains an unclassified key, so a new field can never leak by default.

**Exported on purpose.** Private Hall shells (ids, names, Captain and Members) and the `contentPolicy` terms travel as structure: they describe how the guild is organised, not what it holds. Only the Rites touching a private Hall are withheld, because a graph names that Hall's work.

**Importing never grants authority.** The imported config goes through the usual propose and confirm path (a widening change needs the Guild Master's confirmation); Rites land as drafts, never active. Local fields come from the importing guild, never from the document: `learningRepos`, and `privateEligible` for Hall and provider ids that already exist; new ids start at `false`. A Charter claiming `privateEligible: true` is ignored.

**Bounded and validated.** A Charter is at most 256 KiB and 50 Rites; its config is checked by `guildConfig` and its graphs by the Rite graph schema; every Rite node `hallId` must exist in the proposed config, else `invalid_charter`. Rite names already in use get a ` (2)`, ` (3)` suffix, deterministically.

We rejected exporting `privateEligible` as a hint (an attestation another guild would have to un-trust) and importing straight to active Rites (it would run unreviewed work with the importer's authority).
