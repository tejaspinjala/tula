-- #222: the one-shot re-key (scripts/rekey-note-links.ts) rewrites a note's stored links, so the
-- app role may delete them. Only the current version's rows are ever rewritten.
grant delete on note_links to guildhall_app;
