-- Verdict <-> Proposal integrity (gateway review F5): 0033 dropped the verdicts -> proposals
-- foreign key because a content hash is no longer unique per guild. The two triggers below keep
-- the same guarantee: a Verdict is written only for content that has a Proposal, and every
-- Proposal has its Verdict by commit (the store inserts the Proposal first, then the Verdict).

create function verdict_needs_proposal() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from proposals
    where guild_id = new.guild_id and content_hash = new.proposal_hash
  ) then
    raise exception 'verdict_needs_proposal: no Proposal has this content hash'
      using errcode = '23503';
  end if;
  return new;
end $$;

create trigger verdict_needs_proposal
  before insert on verdicts
  for each row execute function verdict_needs_proposal();

create function proposal_needs_verdict() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from verdicts
    where guild_id = new.guild_id and proposal_hash = new.content_hash
  ) then
    raise exception 'proposal_needs_verdict: no Verdict recorded for this content'
      using errcode = '23503';
  end if;
  return null;
end $$;

create constraint trigger proposal_needs_verdict
  after insert on proposals
  deferrable initially deferred
  for each row execute function proposal_needs_verdict();
