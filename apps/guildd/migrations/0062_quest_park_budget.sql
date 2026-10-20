-- Parking a Quest on its Sub-Quests spends a delivery (the attempt is the fencing token), but a
-- wait is not a crash: parking raises `max_attempts` by one so the crash-retry budget is unchanged.

grant update (max_attempts) on quests to guildhall_app;
