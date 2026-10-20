-- Indexes behind the batch/followups read paths (#58, #59): each query below touches only the
-- recent or relevant rows instead of scanning a guild's whole history.

-- Seals decided in a window (gate denials in the last hour): SealStore.list(decidedSince).
create index seals_guild_decided on seals (guild_id, decided_at) where decided_at is not null;
