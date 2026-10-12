//! Add-ons: optional feature packs — the Thermal Analysis Studio and the
//! Photogrammery tab — delivered by their own installers.
//!
//! An add-on is a folder `<app data dir>/addons/<id>/` holding an `addon.json`
//! manifest (plus whatever runtime files it needs, e.g. the DJI Thermal SDK
//! DLLs under `tsdk/`). Its presence switches on the UI it `provides`;
//! `addons/disabled.json` lists ids the user turned off without uninstalling.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(feature = "tauri-app")]
pub mod commands;

/// Bundle identifier (tauri.conf.json): the app data folder name under the
/// OS data directory, which the add-on installers target directly.
pub const APP_IDENTIFIER: &str = "com.drone-logbook";

pub const MANIFEST_FILE: &str = "addon.json";
const DISABLED_FILE: &str = "disabled.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// Features the add-on switches on ("thermal", "photogrammetry").
    #[serde(default)]
    pub provides: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddonInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub provides: Vec<String>,
    pub enabled: bool,
    pub path: String,
}

pub fn addons_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("addons")
}

/// Add-on ids double as folder names: lowercase letters, digits and dashes only.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn disabled_ids(data_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(addons_dir(data_dir).join(DISABLED_FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub fn set_disabled(data_dir: &Path, id: &str, disabled: bool) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("Invalid add-on id '{id}'"));
    }
    let mut ids = disabled_ids(data_dir);
    ids.retain(|x| x != id);
    if disabled {
        ids.push(id.to_string());
    }
    let dir = addons_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create add-ons folder: {e}"))?;
    std::fs::write(
        dir.join(DISABLED_FILE),
        serde_json::to_string(&ids).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write add-on state: {e}"))
}

/// Installed add-ons (folders with a valid manifest), sorted by name.
pub fn list_installed(data_dir: &Path) -> Vec<AddonInfo> {
    let dir = addons_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let disabled = disabled_ids(data_dir);
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path.join(MANIFEST_FILE)) else {
            continue;
        };
        let manifest: AddonManifest = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Ignoring add-on at {}: invalid manifest ({e})", path.display());
                continue;
            }
        };
        // The folder is the identity; a manifest claiming another id is not trusted
        if !valid_id(&manifest.id) || entry.file_name().to_string_lossy() != manifest.id {
            log::warn!(
                "Ignoring add-on at {}: manifest id '{}' does not match its folder",
                path.display(),
                manifest.id
            );
            continue;
        }
        out.push(AddonInfo {
            enabled: !disabled.contains(&manifest.id),
            path: path.to_string_lossy().to_string(),
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            provides: manifest.provides,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Remove an installed add-on: run its own uninstaller when it has one (that
/// also clears its entry in Windows' Apps list), then delete the folder.
pub fn uninstall(data_dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("Invalid add-on id '{id}'"));
    }
    let dir = addons_dir(data_dir).join(id);
    if !dir.join(MANIFEST_FILE).is_file() {
        return Err(format!("Add-on '{id}' is not installed"));
    }
    // A DLL mapped into the process cannot be deleted on Windows: once the
    // Thermal Studio has loaded the SDK from this folder, removal would only
    // half-succeed (manifest gone, DLLs orphaned and still found next start).
    if let Some(loaded) = crate::thermal::sdk::loaded_sdk_dir() {
        if loaded.starts_with(&dir) {
            return Err(
                "This add-on's DJI Thermal SDK is in use by the current session. Restart Open \
                 DroneLog and remove the add-on before opening the Thermal Studio."
                    .to_string(),
            );
        }
    }
    #[cfg(windows)]
    {
        let uninstaller = dir.join("uninstall.exe");
        if uninstaller.is_file() {
            // `_?=<dir>` makes an NSIS uninstaller run in place (so it can be
            // waited for) with that folder as its install dir; `/S` = silent.
            match std::process::Command::new(&uninstaller)
                .arg("/S")
                .arg(format!("_?={}", dir.display()))
                .status()
            {
                Ok(status) if status.success() => {}
                Ok(status) => log::warn!("Add-on '{id}' uninstaller exited with {status}; removing its folder anyway"),
                Err(e) => log::warn!("Add-on '{id}' uninstaller could not run ({e}); removing its folder anyway"),
            }
        }
    }
    // The uninstaller leaves itself behind when run in place; clear the rest
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove add-on '{id}': {e}"))?;
    }
    // A removed add-on must not stay on the disabled list
    let _ = set_disabled(data_dir, id, false);
    Ok(())
}

/// Where the Thermal add-on installs the DJI Thermal SDK runtime
/// (`<OS data dir>/<app identifier>/addons/thermal/tsdk`).
pub fn thermal_sdk_dir_in_addons() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER).join("addons").join("thermal").join("tsdk"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_manifest(root: &Path, folder: &str, json: &str) {
        let dir = addons_dir(root).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), json).unwrap();
    }

    #[test]
    fn ids_are_folder_safe() {
        assert!(valid_id("thermal"));
        assert!(valid_id("photo-grammetry2"));
        assert!(!valid_id(""));
        assert!(!valid_id("Thermal"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("a b"));
    }

    #[test]
    fn lists_valid_add_ons_and_honours_disabled_state() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_manifest(
            root,
            "thermal",
            r#"{"id":"thermal","name":"Thermal","version":"1.0","provides":["thermal"]}"#,
        );
        write_manifest(
            root,
            "photogrammetry",
            r#"{"id":"photogrammetry","name":"Photogrammetry","provides":["photogrammetry"]}"#,
        );
        // Folder/manifest mismatch and malformed manifests are ignored
        write_manifest(root, "evil", r#"{"id":"thermal","name":"Imposter"}"#);
        write_manifest(root, "broken", "not json");

        let listed = list_installed(root);
        assert_eq!(
            listed.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["photogrammetry", "thermal"]
        );
        assert!(listed.iter().all(|a| a.enabled));
        assert_eq!(listed[1].version, "1.0");
        assert_eq!(listed[0].version, ""); // missing fields default

        set_disabled(root, "thermal", true).unwrap();
        let listed = list_installed(root);
        assert!(!listed.iter().find(|a| a.id == "thermal").unwrap().enabled);
        assert!(listed.iter().find(|a| a.id == "photogrammetry").unwrap().enabled);

        set_disabled(root, "thermal", false).unwrap();
        assert!(list_installed(root).iter().all(|a| a.enabled));
    }

    #[test]
    fn uninstall_removes_folder_and_disabled_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_manifest(root, "thermal", r#"{"id":"thermal","name":"Thermal"}"#);
        set_disabled(root, "thermal", true).unwrap();
        uninstall(root, "thermal").unwrap();
        assert!(list_installed(root).is_empty());
        assert!(disabled_ids(root).is_empty());
        assert!(uninstall(root, "thermal").is_err());
        assert!(uninstall(root, "../etc").is_err());
    }
}
