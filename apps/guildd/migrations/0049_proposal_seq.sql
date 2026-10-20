-- Proposal order (core loop flake): created_at ties under a fixed clock (or within one millisecond),
-- so "latest Proposal of a Quest" was decided by a random uuid. seq is a monotonic insertion order.
alter table proposals add column seq bigint generated always as identity;
create index proposals_latest_by_quest on proposals (guild_id, quest_id, seq desc);
