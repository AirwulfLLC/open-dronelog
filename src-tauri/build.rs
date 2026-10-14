use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

fn main() {
    ensure_default_icon();

    // Only run tauri_build when the tauri-app feature is enabled
    #[cfg(feature = "tauri-app")]
    tauri_build::build();

    // Test executables (`cargo test`) link the Tauri runtime as well, and the
    // Windows loader then needs the Common-Controls v6 manifest tauri-build
    // embeds into the app binary (TaskDialogIndirect lives in comctl32 v6);
    // without it a test binary fails to start with STATUS_ENTRYPOINT_NOT_FOUND.
    #[cfg(feature = "tauri-app")]
    embed_test_manifest();
}

fn ensure_default_icon() {
    let icon_dir = Path::new("icons");
    let icon_path = icon_dir.join("icon.png");

    if icon_path.exists() {
        return;
    }

    if let Err(error) = fs::create_dir_all(icon_dir) {
        eprintln!("Failed to create icons directory: {}", error);
        return;
    }

    let base64_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";
    match STANDARD.decode(base64_png) {
        Ok(bytes) => {
            if let Err(error) = fs::write(&icon_path, bytes) {
                eprintln!("Failed to write default icon: {}", error);
            }
        }
        Err(error) => eprintln!("Failed to decode default icon: {}", error),
    }
}

/// Common-Controls v6 manifest for MSVC test executables (see `main`).
#[cfg(feature = "tauri-app")]
fn embed_test_manifest() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };
    let path = Path::new(&out_dir).join("test.manifest");
    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;
    if let Err(error) = fs::write(&path, MANIFEST) {
        eprintln!("Failed to write the test manifest: {}", error);
        return;
    }
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", path.display());
}
