---
name: handoff
description: Write a compact handoff note when context nears the limit, so the next agent resumes cleanly.
---
# handoff
Write brain/runs/<timestamp>-<agent>.md and return its path plus a <=150-word summary. The next agent reads this instead of re-deriving your work.

## Format
```
---
type: handoff
agent: <id>
task: <one line>
---
Done: <verified results, with file:line / test names>
Next: <the single next action>
Open: <questions, unverified items>
Files: <paths touched>
```

## Rules
Facts only. Mark anything unverified. Do not paste code or logs; reference paths.
