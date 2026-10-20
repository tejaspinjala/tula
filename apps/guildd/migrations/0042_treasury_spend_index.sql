-- The day-spend query (#28 review F6) finds a day's reservations through (guild_id, day), then the
-- settle and release entries of those spends by spend_id. Without this index the second lookup
-- scans every ledger row of the guild. It covers every entry that belongs to a spend (the
-- reservation and its refunds), which is a superset of the reservation-only partial index.

create index treasury_ledger_by_spend on treasury_ledger (guild_id, spend_id)
  where spend_id is not null;
