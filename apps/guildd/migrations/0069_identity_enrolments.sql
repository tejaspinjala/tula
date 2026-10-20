-- One-time enrolment links: the Guild Master, with shell access on the host, mints a token that
-- lets a new device register one more passkey without a live session. Only the token's hash is
-- kept, with its guild. One outstanding token per guild (minting again replaces it); it is
-- deleted in the same transaction that stores the credential it authorised.
--
-- An enrolment ceremony is a fifth kind of single-use challenge; it records the token's hash in
-- the existing founding_hash column (the hash of the one-time token that started the ceremony).

create table identity_enrolments (
  guild_id uuid not null references guilds (guild_id),
  token_hash text not null,
  expires_at timestamptz not null,
  primary key (guild_id)
);

alter table identity_enrolments enable row level security;
alter table identity_enrolments force row level security;
create policy identity_enrolments_tenant on identity_enrolments
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, update, delete on identity_enrolments to guildhall_app;

alter table identity_challenges drop constraint identity_challenges_kind_check;
alter table identity_challenges add constraint identity_challenges_kind_check
  check (kind in ('register', 'signin', 'reauth', 'checkpoint', 'enrol'));
