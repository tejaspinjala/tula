-- Signed audit-chain checkpoints (#31). Each row records a chain position (seq + MAC) that was
-- verified and then signed by the Guild Master's re-authenticated action. The signature is a
-- KeyProvider MAC computed in the app, so database access alone cannot forge a row. The same
-- checkpoint is also published to an anchor outside Postgres, which is what makes truncation of
-- the chain's tail detectable; this table lets verify start from the latest checkpoint instead of
-- replaying the whole chain.

create table audit_checkpoints (
  guild_id uuid not null,
  seq bigint not null check (seq >= 1),
  mac text not null check (mac ~ '^[0-9a-f]{64}$'),
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (guild_id, seq)
);

alter table audit_checkpoints enable row level security;
alter table audit_checkpoints force row level security;

create policy audit_checkpoints_tenant on audit_checkpoints
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- The app appends and reads checkpoints; it is granted no update or delete.
grant select, insert on audit_checkpoints to guildhall_app;

create trigger audit_checkpoints_append_only before update or delete on audit_checkpoints
  for each row execute function audit_chain_reject_change();
create trigger audit_checkpoints_no_truncate before truncate on audit_checkpoints
  for each statement execute function audit_chain_reject_change();
