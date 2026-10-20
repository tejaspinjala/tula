-- Notes can carry a caller-chosen idempotency key, unique per guild, so a retried caller (accepting a
-- suggested learning again after a partial failure) gets the note it already made, never a copy.
-- Set on insert only; RLS and grants are unchanged.

alter table notes add column idempotency_key text
  check (idempotency_key is null or length(idempotency_key) between 1 and 200);

create unique index notes_guild_idempotency_key on notes (guild_id, idempotency_key)
  where idempotency_key is not null;
