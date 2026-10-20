# Embedded passkeys until v2, behind an identity port

guildd verifies the Guild Master's WebAuthn passkeys itself, behind an `IdentityProvider` port, instead of running tula-auth as an external service as the SPEC planned. v1 has one Guild Master on one Mac, so a separate identity service is operational weight with no benefit; the port lets v2 swap in tula-auth when signup and many Guild Masters arrive.
