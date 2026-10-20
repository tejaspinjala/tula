---
paths:
  - apps/guildd/src/ports/**
  - apps/guildd/src/adapters/**
---

# Port and adapter rules

- Every port has a shared contract suite (`<port>.contract.ts`) that runs against the memory adapter and every real adapter. A guarantee lives in the contract suite, not in one adapter's tests.
- A memory adapter keeps the real adapter's atomicity. No `await` between a check and the write it guards (first-writer-wins, unique keys, single-use tokens): do the check and the write synchronously, or chain them per key. The contract suite proves each such guarantee with a same-tick `Promise.all` test, which a staggered test does not.
- A memory adapter holds state only in its instance, never in module scope, so each harness gets a fresh store.
- Secret material (keys, tokens, secret values) crosses a port only as an opaque handle or ciphertext; adapters never log it or put it in an error.
