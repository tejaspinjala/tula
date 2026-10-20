-- Why a run was revoked: a Hall pause revokes its runs and they may be reissued once the Hall
-- resumes ('hall_paused'); a revoke by the Guild Master or a governance path is final ('manual').
-- Runs revoked before this column carry no reason and are never reissued (fail closed).

alter table model_runs
  add column revoke_reason text check (revoke_reason in ('hall_paused', 'manual'));
