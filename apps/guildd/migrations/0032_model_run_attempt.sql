-- Gateway review: a run token is bound to the Quest attempt (delivery) it was opened for. The
-- gateway re-reads the Quest on every call and refuses the token once the attempt is no longer the
-- Quest's live lease. Runs that predate the column belong to the first attempt.

alter table model_runs
  add column attempt integer not null default 1 check (attempt >= 1);
alter table model_runs alter column attempt drop default;
