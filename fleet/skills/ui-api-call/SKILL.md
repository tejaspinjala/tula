---
name: ui-api-call
description: Wire a UI control (button/form) to an HTTP API with correct states, errors and tests.
---
# ui-api-call
A control triggers one request and shows loading, success and failure. Read only the section you need.

## Contract
Get the endpoint contract from the code or OpenAPI file named in the task: method, path, request body, success shape, error shapes. If it is not written down, it is unverified: ask your manager, do not guess.

## Request
One typed client function per endpoint, in the existing API-client module. Handler calls the function; the component never builds URLs or headers. Reuse the project's fetch wrapper and auth.

## States
idle -> loading (control disabled, no double submit) -> success | error. Reset to idle after the user acts again. Keep state local unless another component reads it.

## Errors
Map by status class: 4xx show the server's message if the contract defines one, else a fixed string; 401 -> existing auth flow; 5xx/network -> retry affordance. Never swallow the error and never show raw stack or response bodies.

## Tests
One test per state transition, written first: click -> request sent with expected body; success renders; each error class renders; double click sends once. Mock at the client function boundary.

## Docs
Document behaviour only: "Clicking X sends POST /orders with {...}; on 201 shows Y". Cite the test file:line that proves each sentence.
