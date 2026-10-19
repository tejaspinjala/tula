---
name: publish-gate
description: Stage content (posts, videos) for human approval; agents never publish.
---
# publish-gate
Agents draft and stage. A human approves. The PreToolUse gate denies any publish/send/post action until an approval exists for that exact action.

## Stage
Write to staging/posts/<slug>.md or staging/video/<id>/vN/. Include: channel, intended time, final text, source facts (brain links), and a one-line risk check (claims, names, numbers).

## Approve
Run the publish step normally. The gate denies it and files an approval request. Report the approval id to your parent and stop; do not retry. A human runs `npm run approve -- approve <id>` or uses the dashboard.

## Versions
Never overwrite. New cut = vN+1 with a changelog line (what changed, why). e-diagrammer records the version chain in an Excalidraw decision note.
