-- Least privilege for identity tables. 0007 granted delete on all of them, but the stores only
-- delete challenges (expiry, single use) and founding tokens (single use). Credentials and
-- sessions are never deleted by the app, so the app role loses that privilege.
revoke delete on identity_credentials, identity_sessions from guildhall_app;
