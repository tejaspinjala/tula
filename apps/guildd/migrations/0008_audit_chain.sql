-- Keyed audit chain: one entry per event, each MAC covering the previous entry's MAC. The MACs are
-- computed in the app with a key from the KeyProvider port; the key is never in Postgres, so
-- nobody with database access alone can forge or repair an entry.

create table audit_chain (
  guild_id uuid not null,
  seq bigint not null check (seq >= 1),
  prev_mac text not null check (prev_mac ~ '^[0-9a-f]{64}$'),
  mac text not null check (mac ~ '^[0-9a-f]{64}$'),
  primary key (guild_id, seq),
  foreign key (guild_id, seq) references events (guild_id, seq)
);

alter table audit_chain enable row level security;
alter table audit_chain force row level security;

create policy audit_chain_tenant on audit_chain
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

-- The app appends and reads entries; it is granted no update or delete.
grant select, insert on audit_chain to guildhall_app;

-- Defence in depth: even the owner cannot rewrite the chain without disabling the trigger.
create function audit_chain_reject_change() returns trigger language plpgsql as $$
begin
  raise exception 'audit_chain is append-only' using errcode = 'restrict_violation';
end
$$;

create trigger audit_chain_append_only before update or delete on audit_chain
  for each row execute function audit_chain_reject_change();
create trigger audit_chain_no_truncate before truncate on audit_chain
  for each statement execute function audit_chain_reject_change();
