-- A research slot records whether its call finished, so a sweep can release what a crash left
-- reserved. `settled_at` is stamped once the call is over (its spend settled or given back, or
-- none was needed). The spend itself is found by its Treasury key, `research:<call_id>`.

alter table research_calls add column settled_at timestamptz;

create index research_calls_unsettled on research_calls (guild_id, made_at)
  where released_at is null and settled_at is null;

grant update (settled_at) on research_calls to guildhall_app;
