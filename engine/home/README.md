# engine/home: $FLEET_HOME, config registry, doctor, age keys (P0-6)

Tests: `tests/unit/home/*.test.ts` (temp dirs only; the real `~` is never touched).

## home.ts
Does: `initHome({home?, run?})` creates the SPEC 17 layout under `$FLEET_HOME` (default `~/.tula-fleet`; `private/` and `exec/` are 0700), writes/extends `.gitignore` (adds `private/`, `exec/`, `brain/private/`, `state/`, `host.json`, `STOP`, lock/temp files; keeps owner lines) and runs `git init -b main` (A8). Idempotent. Writes no secrets. Never commits.
Divergence: the task text said `config/`; the spec layout is `company.json` + `org/...`, so that is what is created.

## registry.ts + kinds.ts
Does: `ConfigRegistry` is generic over `registerKind({kind, schema, file|dir, check?})`. `loadAll()` reads every registered location; no files at all is a valid empty company. A file that fails JSON/schema/id/`check` is reported as a `ConfigIssue` and the last-good version stays active (`keptLastGood`). `reloadFile(path)` is the watcher entry point (`loaded|rejected|removed|ignored`). `kinds.ts` is a data table of the P0-2 kinds; `createDefaultRegistry(home)` registers it.
Not guaranteed: no file watching here (P1-C); last-good is in memory only, so a bad file at process start leaves that object absent.

## private-eligible.ts
Does: the `providers` kind check. `privateEligible: true` loads only for a claude-code adapter with `auth: subscription`, a loopback `baseUrl`, or when a chain-valid owner confirmation (`approvals/private-provider-confirmations.jsonl`, `decidedBy: 'owner'`, bound to a fingerprint of adapter/auth/baseUrl/secretRef) exists. Otherwise the whole providers file is rejected (fail closed). `confirmPrivateProvider(id, {home})` writes the record plus an audit entry; `engine/bin/owner.ts` is the stub CLI.
Not guaranteed: the chain is unkeyed (see lib README), so someone who can write the home can forge a valid chain. Protection is the owner-only write scope (P0-4) and the head in backups.

## keys.ts, doctor.ts
Does: `keys init` shells out to `age-keygen`, stores `private/age-identity.txt` (0600) and `private/age-recipient.txt`; never overwrites; "not installed" is reported plainly. `runDoctor()` returns pass/warn/fail checks (home, git repo, .gitignore, config, private mode, disk encryption via `fdesetup`/`lsblk -s`, age, bun, env secrets by name, audit/approvals chains); `bun run doctor` exits 1 on any fail. All commands go through an injectable `Runner`.
Divergence: SPEC 25 says the identity goes to the OS keychain; here it is a 0600 file in git-ignored `private/`. Keychain storage is left for the isolation phase.
