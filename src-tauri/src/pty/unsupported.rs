//! Fallback `PtyManager` for platforms without a local shell (Android, iOS).
//!
//! Mirrors the public API of the desktop implementation in `mod.rs` so the
//! command layer and `AppState` stay identical across platforms; every
//! operation that would need a real PTY reports that it is unavailable.

use tauri::AppHandle;

const UNSUPPORTED: &str = "Local terminal is not available on this platform.";

#[derive(Clone, Default)]
pub struct PtyManager;

impl PtyManager {
    pub fn new() -> Self {
        PtyManager
    }

    pub fn detect_default_shell() -> String {
        String::new()
    }

    pub async fn spawn(
        &self,
        _app: AppHandle,
        _session_id: String,
        _cols: u16,
        _rows: u16,
        _shell_path: Option<String>,
    ) -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub async fn write(&self, _session_id: &str, _data: &[u8]) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub async fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub async fn kill(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub async fn kill_all(&self) {}
}
