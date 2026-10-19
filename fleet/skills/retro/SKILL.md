---
name: retro
description: After each slice, capture what worked or failed so the fleet improves next time.
---
# retro
Short loop that makes the fleet compound. Runs by the project manager after every slice, before moving on.

## Capture
Answer in <=5 lines: what worked (with proof), what failed or was slow (with proof), what was assumed, which skill section was missing or too big, which model tier was wasted or too weak.

## Promote
Pattern only from a success with evidence you can point at. Failure with evidence -> anti-pattern. Unproven -> assumptions/. Promoting an assumption to fact or pattern needs a test, measurement or code reference added to `evidence`.

## Prune
If a note duplicates another, merge and delete. If a skill section was never loaded in 10 runs or always loaded together with another, fold it in. Update routes.json when a rule routed to the wrong employee.
