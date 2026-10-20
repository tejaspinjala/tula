-- Hall pauses (Tripwires). A Hall has at most one active pause: the row is the pause, and a
-- resume deletes it (the hall.paused and hall.resumed events keep the history in the ledger).
-- Pause numbers are observations and thresholds only, never content.

create table hall_pauses (
  guild_id uuid not null references guilds (guild_id),
  seq bigint generated always as identity,
  pause_id uuid not null default gen_random_uuid(),
  hall_id text not null check (length(hall_id) between 1 and 64),
  tripwire text not null check (tripwire in ('token_burn', 'gate_denials', 'loop', 'manual')),
  observed double precision not null,
  threshold double precision not null,
  paused_at timestamptz not null default now(),
  primary key (guild_id, seq),
  unique (guild_id, pause_id),
  unique (guild_id, hall_id)
);

alter table hall_pauses enable row level security;
alter table hall_pauses force row level security;
create policy hall_pauses_tenant on hall_pauses
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert, delete on hall_pauses to guildhall_app;
