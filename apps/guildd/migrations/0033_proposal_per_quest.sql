-- Proposals per Quest (gateway review): 0028 made content_hash unique per guild, so identical
-- content proposed under a second Quest returned the first Quest's Proposal and lost the
-- association. A Proposal is now unique per (guild, Quest, content hash). The Verdict stays keyed
-- by hash alone: shared by every Proposal of that exact content, written once and immutable. Its
-- foreign key to proposals(guild_id, content_hash) cannot survive (the hash is no longer unique
-- there), so the Verdict is written with, and only with, the first Proposal of that content.

alter table verdicts drop constraint verdicts_guild_id_proposal_hash_fkey;
alter table proposals drop constraint proposals_guild_id_content_hash_key;
alter table proposals add constraint proposals_guild_quest_hash_key
  unique (guild_id, quest_id, content_hash);
create index proposals_by_hash on proposals (guild_id, content_hash);
