-- Desktop hand-off codes: a signed-in browser session mints a single-use code that the desktop
-- shell exchanges for its own session (ADR-0010, docs/spikes/tauri-passkeys.md). Only the code's
-- hash is kept, with its guild. One outstanding code per guild (minting again replaces it); it is
-- deleted when spent, and it is useless after 60 seconds (the expiry is checked on spend).

create table identity_desktop_codes (
  guild_id uuid not null references guilds (guild_id),
  code_hash text not null,
  expires_at timestamptz not null,
  primary key (guild_id)
);

alter table identity_desktop_codes enable row level security;
alter table identity_desktop_codes force row level security;
create policy identity_desktop_codes_tenant on identity_desktop_codes
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on identity_desktop_codes to guildhall_app;
