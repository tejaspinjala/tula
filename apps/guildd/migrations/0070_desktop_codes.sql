-- Desktop hand-off codes: a signed-in browser session mints a single-use code that the desktop
-- shell exchanges for its own session (ADR-0010, docs/spikes/tauri-passkeys.md). Only hashes are
-- kept, with the guild: the code's, and the shell's `state` (a random value the shell chose when
-- it opened the browser, so a code someone else minted cannot be pushed into this shell). A few
-- codes per guild may be outstanding (the store evicts the oldest beyond a cap and deletes expired
-- rows when it issues one); a code is deleted when spent and is useless after 60 seconds. It also
-- records when the minting session expires: a session the code opens never outlives it.

create table identity_desktop_codes (
  guild_id uuid not null references guilds (guild_id),
  code_hash text not null,
  state_hash text not null,
  expires_at timestamptz not null,
  session_expires_at timestamptz not null,
  primary key (guild_id, code_hash)
);

alter table identity_desktop_codes enable row level security;
alter table identity_desktop_codes force row level security;
create policy identity_desktop_codes_tenant on identity_desktop_codes
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on identity_desktop_codes to guildhall_app;
