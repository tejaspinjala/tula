//! Browser sign-in hand-back (docs/spikes/tauri-passkeys.md, path b). Passkeys do not work in the
//! shell's webview, so the page asks for the system browser, the browser signs in and opens
//! `guildhall://signed-in#code=<code>`, and the shell sends its window to
//! `https://<host>/#desktop-code=<code>`. Pure functions only: the window and OS calls live in
//! `main.rs`.

use url::Url;

/// The deep-link scheme the app registers.
pub const SCHEME: &str = "guildhall";

/// The user-agent token the shell adds, by which the page knows it runs inside the shell.
pub const USER_AGENT_TOKEN: &str = "GuildhallDesktop";

/// The webview's user agent with the shell token appended (a custom agent replaces the default).
pub fn desktop_user_agent() -> String {
    unimplemented!()
}

/// The sign-in code in a `guildhall://signed-in#code=<code>` link, or `None` for anything else:
/// another scheme or host, a missing or malformed code. A code is `<uuid>.<base64url>`, which is
/// all the shell ever puts into a URL, so nothing else is passed on.
pub fn code_from_deep_link(link: &str) -> Option<String> {
    let _ = link;
    unimplemented!()
}

/// Where the main window goes to finish the sign-in: the server's origin with the code in the
/// fragment, which a browser never sends to a server or writes to a log.
pub fn return_url(server: &Url, code: &str) -> Url {
    let _ = (server, code);
    unimplemented!()
}

/// Whether a window the page asked to open is the browser sign-in (`/?desktop=1` on the server's
/// own origin), which the shell hands to the system browser. Every other request is refused.
pub fn is_browser_sign_in(server: &Url, requested: &Url) -> bool {
    let _ = (server, requested);
    unimplemented!()
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

    #[test]
    fn a_signed_in_link_yields_its_code() {
        let link = format!("guildhall://signed-in#code={CODE}");
        assert_eq!(code_from_deep_link(&link).as_deref(), Some(CODE));
    }

    #[test]
    fn anything_but_a_well_formed_signed_in_link_yields_nothing() {
        for link in [
            "guildhall://signed-in",
            "guildhall://signed-in#code=",
            "guildhall://signed-in#code=junk",
            "guildhall://signed-in?code=11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ",
            "guildhall://other#code=11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ",
            "https://signed-in/#code=11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ",
            "guildhall://signed-in#code=11111111-1111-4111-8111-111111111111.c2VjcmV0LXNlY3JldC1zZWNyZXQ&x=1",
            "guildhall://signed-in#code=11111111-1111-4111-8111-111111111111.short",
            "not a url",
            "",
        ] {
            assert_eq!(code_from_deep_link(link), None, "{link}");
        }
    }

    #[test]
    fn the_return_url_carries_the_code_only_in_the_fragment_of_the_server_origin() {
        let url = return_url(&server(), CODE);
        assert_eq!(url.as_str(), format!("https://guild.example.com/#desktop-code={CODE}"));
        assert_eq!(url.query(), None);
        let deep = Url::parse("https://guild.example.com:8443/app/?x=1").unwrap();
        assert_eq!(
            return_url(&deep, CODE).as_str(),
            format!("https://guild.example.com:8443/#desktop-code={CODE}")
        );
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
