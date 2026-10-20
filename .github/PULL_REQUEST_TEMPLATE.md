<!-- Fill every section from the actual diff. Delete a section only if it genuinely does not apply. -->

## Summary

<!-- What this PR does and why. Link the issue: #<n>. -->

## What changed

-

## Structure

- [ ] Tenant tables carry `guild_id`, are covered by forced row-level security, and have a cross-guild test
- [ ] Anything outside the process goes through a port with a memory adapter
- [ ] Lists are paginated; outbound calls have timeouts and bounded retries; retried handlers are idempotent

## Testing

- [ ] `bun run verify` passes locally
- [ ] Regression test added for every bug fixed or review finding addressed
- [ ] Not run or not verified (be specific):

## Run check

<!-- Report from /run-check: commands run, what was exercised, evidence, what could not be run and why. -->

## Review

<!-- Final verdict from the review loop, plus findings fixed / dismissed (with evidence) / deferred (issue link). -->

## Security impact

<!-- Secrets, tenant isolation, private data, Seals or Treasury touched? Write "None" if not. -->

## Breaking changes

<!-- Contract or schema changes, or "None". -->
