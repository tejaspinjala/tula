-- Treasury principals (#28 review): who acted. A ledger entry records the member (session
-- principal) whose action posted it, covered by the entry hash; a spend records the member who
-- approved it as Guild Master. Both are nullable: the founding seed has no actor, and only an
-- approved spend has an approver. Adding columns does not touch the append-only trigger.

alter table treasury_ledger add column actor_member text
  check (length(actor_member) between 1 and 200);
alter table treasury_spends add column approved_by_member text
  check (length(approved_by_member) between 1 and 200);
