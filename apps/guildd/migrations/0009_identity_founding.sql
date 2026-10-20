-- Founding tokens: a guild's first passkey needs the single-use token issued when it was founded,
-- and a register challenge records whether it was started by founding (the token's hash) or by
-- a session (session_id).

alter table identity_challenges add column founding_hash text;

create table identity_founding (
  guild_id uuid not null references guilds (guild_id),
  token_hash text not null,
  expires_at timestamptz not null,
  primary key (guild_id)
);

alter table identity_founding enable row level security;
alter table identity_founding force row level security;
create policy identity_founding_tenant on identity_founding
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on identity_founding to guildhall_app;
