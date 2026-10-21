# Spike: passkeys in the Tauri 2 desktop shell (#106)

Question: does WebAuthn (platform passkeys, iCloud Keychain) work in Tauri 2's WKWebView on macOS when
the window loads the remote https origin (so the RP ID is the tunnel host)?

## What was and was not checked

- Measured (rustc 1.99.1, tauri-cli 2.12.3, tauri 2.12.4): `cargo test` passes (3 settings tests),
  `cargo build` succeeds, and the debug binary starts, first with no settings (first-run page) and then
  with `settings.json` pointing at a local guildd on `http://localhost:8832`, without panicking.
- Not measured: this agent session has no GUI access (`screencapture` fails with "could not create image
  from display", System Events times out), so the window, menu, full screen toggle and the passkey prompt
  were never seen and there are no screenshots. Whether `navigator.credentials.create/get` works in the
  window is **still unmeasured**; the conclusion below is from platform documentation. A human should run
  the debug build (runbook, "Desktop app") against a local guildd, try sign-in, and record the exact
  error or success here.

## Findings (research, unverified locally)

- Tauri on macOS renders with the system WKWebView. WebAuthn there is gated by Apple, not by Tauri.
- For a third-party app, WKWebView only exposes platform passkeys to a page when the app is entitled for
  that page's domain: the `com.apple.developer.associated-domains` entitlement with
  `webcredentials:<host>`, and the host serving `/.well-known/apple-app-site-association` that lists the
  app ID. (Apps holding the restricted `com.apple.developer.web-browser` entitlement may use any domain,
  but Apple grants that to browsers only.)
- Both entitlements are restricted: they need a paid Apple Developer team, a provisioning profile and a
  signed build. An unsigned or ad-hoc `cargo tauri build` app cannot carry them, so `navigator.credentials`
  calls fail (`NotAllowedError`/`NotSupportedError`) or offer only the cross-device QR flow.
- Even when entitled, the app ID in the association file pins the server to one app: a server change
  (serve the AASA file) and an Apple account dependency for a self-hosted, open install.

## Decision

Path (b): sign in through the system browser and hand the session back. Rationale: it works with an
unsigned build, keeps the RP ID as the tunnel host (Safari/Chrome hold the passkeys), and needs no Apple
account. If the manual check shows path (a) works on the Guild Master's signed build, nothing in the shell
changes: it already loads the remote https origin directly with no native bridge, so in-app sign-in is the
same page. The shell is path-agnostic; only the hand-back below is missing.

## Design for (b) (built in #113)

1. In the shell, a "Sign in with browser" action opens `https://<host>/?desktop=1` in the system browser
   (the opener plugin), and the app registers the `guildhall://` deep-link scheme.
2. The page signs in with its passkey as usual, then calls `POST /auth/desktop/begin` with the session.
   guildd returns a one-time code (single use, 60 second expiry, bound to the guild and Member, stored
   hashed) and the page hands `guildhall://signed-in#code=<code>` to the OS (a button, so the code is minted on a user gesture).
3. The shell receives the deep link and loads `https://<host>/#desktop-code=<code>`. The web client posts
   it to `POST /auth/desktop/exchange` over TLS and receives the same Bearer session token a passkey
   sign-in returns, then clears the fragment.
4. Rate-limit both endpoints; the code is useless after one exchange or 60 seconds.

The shell asks for the system browser by opening `/?desktop=1` as a new window (it refuses every other
new window), sets a `GuildhallDesktop/<version>` user-agent suffix so the page offers only
"Sign in with your browser", and keeps the remote origin free of native commands. Not yet covered:
Windows and Linux deep links need the single-instance plugin so a link reaches the running window.
