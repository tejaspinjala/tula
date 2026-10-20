-- The Vault: provider keys stored once, as ciphertext. Each guild has one random data key, kept
-- only in wrapped form (wrapped through the KeyProvider, never readable from the database); each
-- secret is AES-256-GCM sealed under that key with a fresh nonce. No update or delete: a secret
-- is added once and never shown again.

create table vault_keys (
  guild_id uuid not null references guilds (guild_id),
  wrapped_key bytea not null,
  created_at timestamptz not null default now(),
  primary key (guild_id)
);

create table vault_secrets (
  guild_id uuid not null references guilds (guild_id),
  ref text not null check (ref ~ '^[a-z][a-z0-9_-]{0,63}$'),
  sealed bytea not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, ref)
);

alter table vault_keys enable row level security;
alter table vault_keys force row level security;
create policy vault_keys_tenant on vault_keys
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table vault_secrets enable row level security;
alter table vault_secrets force row level security;
create policy vault_secrets_tenant on vault_secrets
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on vault_keys to guildhall_app;
grant select, insert on vault_secrets to guildhall_app;
