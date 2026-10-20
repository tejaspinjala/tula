-- Proposals and Verdicts. A Proposal is drafted content bound to the SHA-256 of that exact content;
-- its Verdict holds the deterministic-check results bound to the same hash. Both are written once
-- and never change: an edit is a new Proposal with a new hash, which the old Verdict cannot judge.

create table proposals (
  guild_id uuid not null references guilds (guild_id),
  proposal_id uuid not null default gen_random_uuid(),
  quest_id uuid not null,
  author text not null check (length(author) between 1 and 200),
  kind text not null check (length(kind) between 1 and 100),
  content text not null check (length(content) between 1 and 20000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (guild_id, proposal_id),
  unique (guild_id, content_hash),
  constraint proposals_hash_binds_content
    check (content_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
);

create table verdicts (
  guild_id uuid not null,
  proposal_hash text not null,
  passed boolean not null,
  findings jsonb not null check (jsonb_typeof(findings) = 'array'),
  checked_at timestamptz not null,
  primary key (guild_id, proposal_hash),
  foreign key (guild_id, proposal_hash) references proposals (guild_id, content_hash)
);

alter table proposals enable row level security;
alter table proposals force row level security;
create policy proposals_tenant on proposals
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

alter table verdicts enable row level security;
alter table verdicts force row level security;
create policy verdicts_tenant on verdicts
  using (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid)
  with check (guild_id = nullif(current_setting('app.guild_id', true), '')::uuid);

grant select, insert on proposals to guildhall_app;
grant select, insert on verdicts to guildhall_app;

-- Immutable even for the owner: no update, no delete. Runs with the caller's rights.
create function proposals_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '%: rows are immutable; a changed Proposal is a new Proposal', tg_table_name
    using errcode = 'check_violation';
end;
$$;

revoke all on function proposals_immutable() from public;

create trigger proposals_immutable
  before update or delete on proposals
  for each row execute function proposals_immutable();

create trigger verdicts_immutable
  before update or delete on verdicts
  for each row execute function proposals_immutable();
