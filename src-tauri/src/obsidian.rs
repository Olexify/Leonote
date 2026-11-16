//! Obsidian's own vault list, read for "open an Obsidian vault" in Settings.
//! Nothing here writes: Leonote no longer mirrors tasks into an Obsidian note.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, PartialEq)]
pub struct VaultCandidate {
    pub path: String,
    /// last path segment
    pub name: String,
    /// the folder is there now
    pub exists: bool,
    /// open in Obsidian when it last ran
    pub open: bool,
}

/// Where Obsidian keeps `obsidian.json`.
pub fn config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.map(|b| b.join("obsidian").join("obsidian.json"))
}

/// Parse `obsidian.json` text: `{"vaults": {"<id>": {"path", "ts", "open"?}}}`.
/// Most recently opened (`ts`) first. Anything malformed yields fewer entries
/// or none, never an error: this only feeds a picker.
pub fn parse_vault_list(text: &str) -> Vec<VaultCandidate> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(vaults) = v.get("vaults").and_then(|x| x.as_object()) else { return Vec::new() };
    let mut out: Vec<(f64, VaultCandidate)> = vaults
        .values()
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?.trim();
            let name = path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
            if name.is_empty() {
                return None;
            }
            let c = VaultCandidate {
                name: name.to_string(),
                exists: Path::new(path).is_dir(),
                open: e.get("open").and_then(|o| o.as_bool()).unwrap_or(false),
                path: path.to_string(),
            };
            Some((e.get("ts").and_then(|t| t.as_f64()).unwrap_or(0.0), c))
        })
        .collect();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, c)| c).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vault_list_is_parsed_from_obsidian_json() {
        let dir = std::env::temp_dir().join("leonote_obsidian_vaults");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("MyVault")).unwrap();
        let real = dir.join("MyVault").to_string_lossy().to_string();
        let gone = format!("{}\\", dir.join("Old Vault").to_string_lossy());
        let text = json!({
            "vaults": {
                "a1": {"path": real, "ts": 1700000000100u64, "open": true},
                "b2": {"path": gone, "ts": 1700000000200u64},
                "c3": {"path": "/home/me/Notes/", "ts": 5},
                "d4": {"ts": 1800000000000u64},
                "e5": {"path": "", "ts": 1800000000000u64},
                "f6": {"path": 42}
            },
            "frame": "hidden"
        })
        .to_string();
        let v = parse_vault_list(&text);
        assert_eq!(
            v,
            vec![
                VaultCandidate { path: gone.clone(), name: "Old Vault".into(), exists: false, open: false },
                VaultCandidate { path: real.clone(), name: "MyVault".into(), exists: true, open: true },
                VaultCandidate { path: "/home/me/Notes/".into(), name: "Notes".into(), exists: false, open: false },
            ]
        );
        for bad in ["", "not json", "[]", r#"{"vaults": []}"#, r#"{"other": 1}"#, r#"{"vaults": {"x": 1}}"#] {
            assert!(parse_vault_list(bad).is_empty(), "{:?}", bad);
        }
    }
}
