# The Archive export is linked Markdown; private notes leave only on request and with re-auth

An **Archive export** lets a Guild Master take the Archive out of Guildhall as plain files that open in any Markdown tool. It is only trustworthy if the folder is portable, keeps facts apart from quarantined assumptions, and never leaks a private note by default.

**A folder of Markdown files.** One file per note at `<Hall name>/<file>.md`; notes with no Hall go under `Guild Master/`, private notes under `Private/<Hall name>/`. `Archive.md` at the root is the index, with separate Facts and Quarantined assumptions sections, counts, and the number of private notes left out. The builder is a pure function (`buildArchiveExport`): the caller reads the notes and writes the files.

**Safe names.** File and folder names strip `/ \ : * ? " < > | # ^ [ ]` and control characters, trim dots and spaces, suffix reserved Windows names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) with `_`, and cap at 120 characters. Collisions (case-insensitive, as on macOS and Windows) get ` (2)`, ` (3)` suffixes assigned in note-id order, so the same Archive always exports to the same paths.

**YAML front matter** carries id, hall, trust, claim, evidence, version, kind, `url` for link notes, and `tags: [quarantined]` for quarantined assumptions. Every string is emitted as a double-quoted scalar with escapes, so `:`, quotes, newlines and a leading `-` cannot change the structure. The title lives in the heading, never in the front matter.

**Links are rewritten, never invented.** `[[Title]]` (matched as `titleKey` does: trimmed, lower-cased) becomes `[[<path>|Title]]` when the target is in the export, so links resolve by path. Otherwise it becomes plain text. A link to a private note that was left out shows `[withheld]`, never the title.

**Private notes leave only on request and with re-auth.** The default export contains no private note; asking for them is a passkey-confirmed action, like unlocking a private Hall (ADR-0012). The index only counts what was left out.

We rejected a single JSON dump (not readable or linkable outside Guildhall) and exporting quarantined assumptions as plain notes (it would blur them with facts once outside the Archive).
