-- Expired stream tickets are deleted by the app (probabilistically, on issue).

grant delete on stream_tickets to guildhall_app;
