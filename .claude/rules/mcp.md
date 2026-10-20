---
paths:
  - apps/guildd/src/mcp/**
  - apps/guildd/src/brief.ts
---

# MCP gateway rules

- Stateless: no session, no process memory. Every tool call authorises itself from its own arguments.
- The guild comes only from a verified, signed token (`mcp/tokens.ts`), never from the path, a header or a body field. The Quest's live lease is re-read from the queue on every call; the attempt is the fencing token.
- A role's tool list is frozen per Campaign through `ToolsetStore` on first use. A new tool is added to the catalogue, never to a running Campaign.
- Archive access is limited to the Quest's Hall through `archive-scope.ts`; artifact access to hashes the Quest holds.
- Events and logs carry ids and hashes only, never Handoff, artifact or note content.
- No model calls and no model ids here.
