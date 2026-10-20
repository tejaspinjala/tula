-- The Guild Master's passkey assertion over each checkpoint (#31): the WebAuthn assertion whose
-- challenge carried the checkpoint hash, kept so verify can re-check it against the credential's
-- public key. The columns are nullable only because earlier rows predate them; verify treats a
-- missing assertion as a failure.

alter table audit_checkpoints
  add column credential_id text,
  add column authenticator_data text,
  add column client_data_json text,
  add column assertion_signature text;

-- Checkpoint-signature ceremonies are a fourth kind of single-use challenge.
alter table identity_challenges drop constraint identity_challenges_kind_check;
alter table identity_challenges add constraint identity_challenges_kind_check
  check (kind in ('register', 'signin', 'reauth', 'checkpoint'));
