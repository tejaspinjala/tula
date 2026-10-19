---
name: brain-write
description: File a note into the company brain with correct type, evidence and links.
---
# brain-write
The brain is an Obsidian vault (brain/). Navigate by links from 00-INDEX.md; never read it wholesale.

## Types
fact: verified, needs `evidence`. pattern: reusable way of working, needs `evidence` from a real success. anti-pattern: something that failed, needs `evidence`. assumption: unverified, `status: unverified`, quarantined. decision: created by adr-excalidraw. glossary: one term per line in glossary.md.

## Frontmatter
```
---
type: fact
status: verified
evidence:
  - src/api/orders.ts:42
  - tests/orders.test.ts "sends once"
---
```

## Links
Link every new note from its parent topic or 00-INDEX.md. Use [[note-name]]. A verified note must not rest on an assumption note.

## Lint
Run `npm run brain:lint` and fix every error before returning.
