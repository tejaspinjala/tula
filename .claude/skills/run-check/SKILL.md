---
name: run-check
description: Exercise a change against the real local stack (docker compose) after verify is green, and write a short Run check report. Use for tickets that change runtime behaviour, at the end of a batch, or when asked to "run it for real".
---

# Run check

Passing tests against memory adapters is not enough for runtime changes. Anything this reveals is a finding: fix it test-first.

1. **Stack.** `docker compose up -d` from the repo root; confirm every service is running with `docker compose ps`. If Docker is not running, report `blocked`, do not skip. If the stack is already up, reuse it and leave it running.
2. **Integration.** Run the real-adapter port suites if the change touches an adapter (`bun run test:integration` once it exists).
3. **Exercise the change** over its public seam: call the changed routes or MCP tools with a real passkey session or lease token, including one failure case and one cross-guild isolation check.
4. **Trace (UI changes).** Drive each page the change touches (Hall, Rites, Guild builder, Missives) with `agent-browser` against your own guildd on a free port, with Chrome on a free debug port. Record a CDP performance trace per page during a scripted walk and count long tasks (over 200 ms). The budget is zero; any long task gets a named cause and a fix in the PR. Keep the traces in the scratchpad and put the long-task count per page in the "Run check" section.
5. **Report**, then paste it into the PR's "Run check" section:
   ```
   Run check: <pass | fail | blocked>
   Commands:  <each command run>
   Exercised: <happy / failure / isolation>
   Evidence:  <paths in the scratchpad, never in the repo>
   Not run:   <what and why>
   ```
6. Stop only a stack you started (`docker compose down`, never `-v` unless asked).

Never leave a command waiting: give stdin `< /dev/null`, give every wait loop a deadline, stop every background process you started.
