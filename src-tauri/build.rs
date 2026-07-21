fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["restart_backend"])),
    )
    .expect("failed to run Tauri build script");
}
