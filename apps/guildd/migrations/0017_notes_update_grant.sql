-- The app only ever moves a note's current_version pointer; every other column is immutable
-- (edits append note_versions rows). Narrows the table-wide update granted in 0014.
revoke update on notes from guildhall_app;
grant update (current_version) on notes to guildhall_app;
