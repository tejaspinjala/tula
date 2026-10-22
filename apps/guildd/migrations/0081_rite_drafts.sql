-- Rite drafts and Publish (ticket #174, ADR-0013): a save is a `draft` that never runs; publishing
-- makes it `active` (superseding the old active version) or `pending` (a widening version waits for
-- the passkey confirm). Stored names keep the old word (ADR-0013).

alter table workflow_versions drop constraint workflow_versions_status_check;
alter table workflow_versions add constraint workflow_versions_status_check
  check (status in ('draft', 'pending', 'active', 'superseded'));

-- Only the status moves, along draft -> pending|active, pending -> active, active -> superseded.
create or replace function workflow_version_frozen() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (new.guild_id, new.workflow_id, new.version, new.name, new.graph, new.classification, new.created_at)
       is distinct from
     (old.guild_id, old.workflow_id, old.version, old.name, old.graph, old.classification, old.created_at)
     or (new.status <> old.status and not (
       (old.status = 'draft' and new.status in ('pending', 'active'))
       or (old.status = 'pending' and new.status = 'active')
       or (old.status = 'active' and new.status = 'superseded'))) then
    raise exception '%: rows are immutable; a changed Workflow is a new version', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Before this, a newer active version silently outranked older ones; now only one is active.
update workflow_versions v set status = 'superseded'
where v.status = 'active' and exists (
  select 1 from workflow_versions n
  where n.guild_id = v.guild_id and n.workflow_id = v.workflow_id
    and n.status = 'active' and n.version > v.version);
