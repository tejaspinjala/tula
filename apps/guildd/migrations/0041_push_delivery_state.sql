-- Push delivery state. A delivery claim is now leased (`pending` until `lease_expires_at`, so a
-- sender that crashed after claiming is retried), counts its attempts (so a device that keeps
-- failing is eventually given up on), and ends `sent` or `failed`. A subscription records the
-- event seq it was made at, so events from before it existed are never pushed to it.
-- Rows written by 0036 were claims that were treated as sent: they default to `sent`.

alter table push_deliveries
  add column state text not null default 'sent' check (state in ('pending', 'sent', 'failed')),
  add column attempts integer not null default 1,
  add column lease_expires_at timestamptz not null default now();

alter table push_subscriptions
  add column since_seq bigint not null default 0;

grant update (state, attempts, lease_expires_at) on push_deliveries to guildhall_app;
