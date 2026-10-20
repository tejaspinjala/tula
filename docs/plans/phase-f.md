# Phase F plan (v2)

Phase F is the v2 scope named in the product spec (issue #6). This file collects design items
that v1 deliberately defers.

## Multi-instance event stream

v1 runs one guildd instance. Two stream choices are per-instance and need a design before a
second instance runs:

- **Socket cap.** `maxSocketsPerGuild` (default 8) counts sockets on this instance only. With N
  instances a guild can hold N times the cap. v2 needs a shared count (or a cap per instance
  sized as a share of a guild-wide limit).
- **In-memory hub.** `createEventHub` keeps live sockets and their cursors in process memory;
  Postgres (the event log plus LISTEN/NOTIFY) is the only shared state. That is correct for
  delivery, since every instance LISTENs and fans out to its own sockets, but the cap and any
  per-guild stream metrics are not shared. Revisit alongside the cap above.
