---
name: docs-contract
description: Rules for docs and brain notes so assumptions never become patterns other agents copy.
---
# docs-contract
Docs describe what the code DOES, proven by code or tests. They never describe intent, hope or a guess. Later agents treat docs as ground truth, so one false sentence gets copied everywhere.

## Template
```
# <thing>
Does: <one sentence, present tense>
Proof: <file:line or test name for every claim>
Interface: <inputs -> outputs>
Unverified: <anything you could not trace; leave empty if none>
```

## Forbidden
"should", "probably", "typically", "best practice", "we assume". Copying a pattern from a doc without checking the code it describes. Describing planned behaviour as current.

## Check
Before saving, reread each sentence and ask: which file:line proves this? No answer -> delete it or move it to Unverified.

## Quarantine
Anything unverified is filed under brain/assumptions/ with `status: unverified`. Only a note with real `evidence:` may be promoted to facts/ or patterns/ (skill: retro).
