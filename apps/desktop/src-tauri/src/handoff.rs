//! Browser sign-in hand-back (docs/spikes/tauri-passkeys.md, path b). Passkeys do not work in the
//! shell's webview, so the page asks for the system browser, the browser signs in and opens
//! `guildhall://signed-in#code=<code>`, and the shell sends its window to
//! `https://<host>/#desktop-code=<code>`. Pure functions only: the window and OS calls live in
//! `main.rs`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use url::Url;

/// The deep-link scheme the app registers.
pub const SCHEME: &str = "guildhall";

/// The user-agent token the shell adds, by which the page knows it runs inside the shell.
pub const USER_AGENT_TOKEN: &str = "GuildhallDesktop";

/// The webview's user agent with the shell token appended (a custom agent replaces the default).
pub fn desktop_user_agent() -> String {
    #[cfg(target_os = "macos")]
    let base = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    #[cfg(target_os = "windows")]
    let base = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    format!("{base} {USER_AGENT_TOKEN}/{}", env!("CARGO_PKG_VERSION"))
}

/// Whether `code` has the shape guildd mints: `<guild uuid>.<at least 16 base64url characters>`.
fn is_code(code: &str) -> bool {
    let Some((guild, secret)) = code.split_once('.') else {
        return false;
    };
    let uuid = guild.len() == 36
        && guild.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    uuid && secret.len() >= 16
        && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Whether `state` has the shape the shell makes: base64url, 22 to 128 characters (at least 128 bits).
fn is_state(state: &str) -> bool {
    (22..=128).contains(&state.len())
        && state.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The code and state in a `guildhall://signed-in#code=<code>&state=<state>` link, or `None` for
/// anything else: another scheme or host, or a missing or malformed code or state. A code is
/// `<uuid>.<base64url>`, which is all the shell ever puts into a URL, so nothing else is passed on.
/// The state still has to match the one the shell is waiting for (see [`PendingSignIn`]).
pub fn code_from_deep_link(link: &str) -> Option<(String, String)> {
    let url = Url::parse(link).ok()?;
    if url.scheme() != SCHEME || url.host_str() != Some("signed-in") || url.query().is_some() {
        return None;
    }
    let fragment = url.fragment()?;
    let (code, state) = fragment.strip_prefix("code=")?.split_once("&state=")?;
    (is_code(code) && is_state(state)).then(|| (code.to_string(), state.to_string()))
}

/// Where the main window goes to finish the sign-in: the server's origin with the code and the
/// state in the fragment, which a browser never sends to a server or writes to a log.
pub fn return_url(server: &Url, code: &str, state: &str) -> Url {
    let mut url = server.clone();
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(Some(&format!("desktop-code={code}&desktop-state={state}")));
    url
}

/// How long a browser sign-in may take before the state the shell is waiting for lapses.
pub const STATE_TTL: Duration = Duration::from_secs(10 * 60);

/// The one sign-in the shell is waiting for: the random state it put in the browser address. A
/// hand-back is accepted only with that state, once, and while it is fresh, so a link someone else
/// built (a code from their own session) cannot sign this shell into their guild. Held in the
/// shell's memory; the shell is a client, not the server.
#[derive(Default)]
pub struct PendingSignIn(Mutex<Option<(String, Instant)>>);

impl PendingSignIn {
    /// Starts a sign-in: makes and remembers a fresh random state (replacing any earlier one).
    pub fn begin(&self, now: Instant) -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("the operating system has no randomness");
        let state = URL_SAFE_NO_PAD.encode(bytes);
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((state.clone(), now));
        state
    }

    /// True once, for the pending state while it is fresh; then nothing is pending. A wrong state
    /// changes nothing, so a stray link cannot cancel the sign-in the user is doing.
    pub fn take(&self, state: &str, now: Instant) -> bool {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match held.as_ref() {
            Some((_, since)) if now.duration_since(*since) > STATE_TTL => {
                *held = None;
                false
            }
            Some((pending, _)) if pending == state => {
                *held = None;
                true
            }
            _ => false,
        }
    }
}

/// The browser sign-in address with the shell's `state` added.
pub fn browser_url(requested: &Url, state: &str) -> Url {
    let mut url = requested.clone();
    url.query_pairs_mut().append_pair("state", state);
    url
}

/// Whether a window the page asked to open is the browser sign-in (`/?desktop=1` on the server's
/// own origin), which the shell hands to the system browser. Every other request is refused.
pub fn is_browser_sign_in(server: &Url, requested: &Url) -> bool {
    requested.scheme() == server.scheme()
        && requested.host_str() == server.host_str()
        && requested.port_or_known_default() == server.port_or_known_default()
        && requested.path() == "/"
        && requested.query_pairs().any(|(k, v)| k == "desktop" && v == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ";

    fn server() -> Url {
        Url::parse("https://guild.example.com/").unwrap()
    }

    #[test]
    fn the_user_agent_keeps_the_default_shape_and_ends_with_the_shell_token() {
        let agent = desktop_user_agent();
        assert!(agent.starts_with("Mozilla/5.0 ("), "{agent}");
        assert!(agent.contains("AppleWebKit") || agent.contains("Gecko"), "{agent}");
        assert!(agent.contains(USER_AGENT_TOKEN), "{agent}");
        assert!(agent.ends_with(&format!("{USER_AGENT_TOKEN}/{}", env!("CARGO_PKG_VERSION"))));
    }

    const STATE: &str = "c3RhdGUtc3RhdGUtc3RhdGUtc3RhdGU";

    #[test]
    fn a_signed_in_link_yields_its_code_and_state() {
        let link = format!("guildhall://signed-in#code={CODE}&state={STATE}");
        assert_eq!(code_from_deep_link(&link), Some((CODE.to_string(), STATE.to_string())));
    }

    #[test]
    fn anything_but_a_well_formed_signed_in_link_yields_nothing() {
        let good = "11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ";
        for link in [
            "guildhall://signed-in".to_string(),
            format!("guildhall://signed-in#code={good}"),
            format!("guildhall://signed-in#code={good}&state="),
            format!("guildhall://signed-in#code={good}&state=short"),
            format!("guildhall://signed-in#state={STATE}&code={good}"),
            format!("guildhall://signed-in#code=junk&state={STATE}"),
            format!("guildhall://signed-in?code={good}&state={STATE}"),
            format!("guildhall://other#code={good}&state={STATE}"),
            format!("https://signed-in/#code={good}&state={STATE}"),
            format!("guildhall://signed-in#code={good}&state={STATE}&x=1"),
            "not a url".to_string(),
            String::new(),
        ] {
            assert_eq!(code_from_deep_link(&link), None, "{link}");
        }
    }

    #[test]
    fn the_return_url_carries_code_and_state_only_in_the_fragment_of_the_server_origin() {
        let url = return_url(&server(), CODE, STATE);
        assert_eq!(
            url.as_str(),
            format!("https://guild.example.com/#desktop-code={CODE}&desktop-state={STATE}")
        );
        assert_eq!(url.query(), None);
        let deep = Url::parse("https://guild.example.com:8443/app/?x=1").unwrap();
        assert_eq!(
            return_url(&deep, CODE, STATE).as_str(),
            format!("https://guild.example.com:8443/#desktop-code={CODE}&desktop-state={STATE}")
        );
    }

    #[test]
    fn a_pending_state_is_random_long_and_replaced_by_the_next_sign_in() {
        let pending = PendingSignIn::default();
        let now = Instant::now();
        let a = pending.begin(now);
        let b = pending.begin(now);
        assert!(is_state(&a) && is_state(&b), "{a} {b}");
        assert_ne!(a, b);
        assert!(!pending.take(&a, now), "the first sign-in was replaced");
        assert!(pending.take(&b, now));
    }

    #[test]
    fn a_hand_back_with_no_pending_wrong_reused_or_stale_state_is_refused() {
        let pending = PendingSignIn::default();
        let now = Instant::now();
        assert!(!pending.take(STATE, now), "nothing pending");
        let state = pending.begin(now);
        assert!(!pending.take(STATE, now), "wrong state");
        assert!(!pending.take("", now), "empty state");
        assert!(pending.take(&state, now), "a wrong try does not cancel the pending sign-in");
        assert!(!pending.take(&state, now), "a state works once");
        let stale = pending.begin(now);
        assert!(!pending.take(&stale, now + STATE_TTL + Duration::from_secs(1)), "expired");
        assert!(!pending.take(&stale, now), "an expired state is gone");
    }

    #[test]
    fn the_browser_address_gains_the_state_and_keeps_the_sign_in_request() {
        let requested = Url::parse("https://guild.example.com/?desktop=1").unwrap();
        let url = browser_url(&requested, STATE);
        assert!(is_browser_sign_in(&server(), &url));
        assert!(url.query_pairs().any(|(k, v)| k == "state" && v == STATE));
        assert_eq!(url.host_str(), Some("guild.example.com"));
    }

    #[test]
    fn only_the_servers_own_sign_in_page_goes_to_the_system_browser() {
        let yes = |s: &str| is_browser_sign_in(&server(), &Url::parse(s).unwrap());
        assert!(yes("https://guild.example.com/?desktop=1"));
        assert!(yes("https://guild.example.com/?a=b&desktop=1"));
        assert!(!yes("https://guild.example.com/"));
        assert!(!yes("https://guild.example.com/?desktop=2"));
        assert!(!yes("https://evil.example.com/?desktop=1"));
        assert!(!yes("http://guild.example.com/?desktop=1"));
        assert!(!yes("https://guild.example.com:8443/?desktop=1"));
        assert!(!yes("file:///etc/passwd"));
    }
}
