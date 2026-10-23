-- Routing waits (a claim given back because routing blocked the Quest) get their own counter, so the
-- routing-wait backoff starts at its first step even for a Quest that already parked or was released.
alter table quests add column routing_waits integer not null default 0 check (routing_waits >= 0);
grant update (routing_waits) on quests to guildhall_app;
