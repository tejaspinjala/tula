//! The server address setting: validation and the settings file.

use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;

/// What is stored in `settings.json` under the app config directory.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Settings {
    #[serde(rename = "serverUrl")]
    pub server_url: String,
}

/// Accepts an `https` address (or `http` for a local server) and returns it normalised.
pub fn parse_server_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&candidate).map_err(|e| format!("not a valid address: {e}"))?;
    let host = url.host_str().ok_or("the address needs a host")?;
    let local = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    match url.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        _ => Err("use an https address (http is only allowed for localhost)".into()),
    }
}

/// Reads the stored address; `None` when the file is missing or unusable (first run).
pub fn load(path: &Path) -> Option<Url> {
    let text = std::fs::read_to_string(path).ok()?;
    let settings: Settings = serde_json::from_str(&text).ok()?;
    parse_server_url(&settings.server_url).ok()
}

/// Validates and stores the address, creating the directory if needed.
pub fn save(path: &Path, input: &str) -> Result<Url, String> {
    let url = parse_server_url(input)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&Settings { server_url: url.to_string() })
        .map_err(|e| e.to_string())?;
    // Write a sibling temp file then rename, so a crash never leaves a truncated settings file.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_host_becomes_https() {
        assert_eq!(
            parse_server_url("guild.example.com").unwrap().as_str(),
            "https://guild.example.com/"
        );
    }

    #[test]
    fn plain_http_is_refused_except_for_localhost() {
        assert!(parse_server_url("http://guild.example.com").is_err());
        assert!(parse_server_url("http://localhost:8832").is_ok());
    }

    #[test]
    fn a_truncated_file_loads_as_first_run_and_save_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("guildhall-desktop-trunc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        std::fs::write(&file, "{\"serverUrl\": \"https://gui").unwrap();
        assert!(load(&file).is_none());
        save(&file, "https://guild.example.com").unwrap();
        assert_eq!(load(&file).unwrap().as_str(), "https://guild.example.com/");
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saved_settings_load_back_and_a_missing_file_is_first_run() {
        let dir = std::env::temp_dir().join(format!("guildhall-desktop-{}", std::process::id()));
        let file = dir.join("settings.json");
        assert!(load(&file).is_none());
        save(&file, "https://guild.example.com").unwrap();
        assert_eq!(load(&file).unwrap().as_str(), "https://guild.example.com/");
        let _ = std::fs::remove_dir_all(dir);
    }
}
