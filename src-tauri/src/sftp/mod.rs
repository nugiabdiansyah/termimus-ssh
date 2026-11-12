#[cfg(target_os = "android")]
mod android_content;

use russh::client::{self, Handle};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::db::Database;
use crate::ssh::{SshAuth, SshClientHandler};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

pub struct SftpConnection {
    pub session_id: String,
    pub host_id: String,
    pub sftp: SftpSession,
    // Keeps the connection open, and tells the liveness watcher when it closed.
    handle: Handle<SshClientHandler>,
}

/// How often a live connection is checked for having died on its own.
const LIVENESS_POLL: Duration = Duration::from_secs(2);
/// Emitted with the session id when a connection is found dead (server gone,
/// network dropped, keepalive timeout) rather than closed by the user.
const SESSION_CLOSED_EVENT: &str = "sftp-session-closed";

pub struct SftpManager {
    connections: Arc<Mutex<HashMap<String, Arc<SftpConnection>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        SftpManager {
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // Clone the handle out of the map so slow IO runs without holding the
    // manager lock; holding it would serialize every SFTP call behind the
    // longest-running transfer.
    async fn connection(&self, session_id: &str) -> Result<Arc<SftpConnection>, String> {
        let connections = self.connections.lock().await;
        connections
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SFTP session not found. Please connect first.".to_string())
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        db: Arc<Database>,
        session_id: String,
        host_id: String,
        address: String,
        port: u16,
        username: String,
        auth: SshAuth,
    ) -> Result<String, String> {
        let config = crate::ssh::default_client_config();
        let handler = SshClientHandler {
            address: address.clone(),
            port,
            db,
            forwarded_tcpip: None,
        };
        let socket = match crate::ssh::connect_tcp(address.as_str(), port).await {
            Ok(s) => {
                crate::ssh::configure_tcp_stream(&s);
                s
            }
            Err(e) => return Err(format!("SFTP TCP connection failed: {e}")),
        };
        let mut handle = client::connect_stream(config, socket, handler)
            .await
            .map_err(|e| format!("SFTP SSH connection failed: {e}"))?;

        let target = format!("{username}@{address}");
        crate::ssh::authenticate(&mut handle, Some(&app), &target, &username, &auth).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Channel open failed: {e}"))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("SFTP subsystem request failed: {e}"))?;

        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("SFTP initialization failed: {e}"))?;

        let initial_path = sftp
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| "/".to_string());

        let conn = Arc::new(SftpConnection {
            session_id: session_id.clone(),
            host_id,
            sftp,
            handle,
        });

        self.connections.lock().await.insert(session_id, conn.clone());
        Self::watch_liveness(app, self.connections.clone(), &conn);

        Ok(initial_path)
    }

    /// Notice when a connection dies without the user disconnecting it.
    ///
    /// Nothing else would: a dead connection only surfaces as an error on the
    /// next file operation, and until then the frontend keeps treating the
    /// pane as connected (on Android that also keeps the keep-alive service
    /// and its notification running for a session that no longer exists).
    ///
    /// The task holds only a `Weak`, so it never keeps a connection alive
    /// after `disconnect` drops it; it ends as soon as the connection is gone.
    fn watch_liveness(
        app: AppHandle,
        connections: Arc<Mutex<HashMap<String, Arc<SftpConnection>>>>,
        conn: &Arc<SftpConnection>,
    ) {
        let weak = Arc::downgrade(conn);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(LIVENESS_POLL).await;
                let Some(conn) = weak.upgrade() else { return };
                if !conn.handle.is_closed() {
                    continue;
                }
                let session_id = conn.session_id.clone();
                let mut map = connections.lock().await;
                // Only report a connection that is still the registered one;
                // the user may have disconnected or reconnected meanwhile.
                let still_registered = map.get(&session_id).is_some_and(|c| Arc::ptr_eq(c, &conn));
                if still_registered {
                    map.remove(&session_id);
                    drop(map);
                    let _ = app.emit(SESSION_CLOSED_EVENT, &session_id);
                }
                return;
            }
        });
    }

    pub async fn list(&self, session_id: &str, path: &str) -> Result<Vec<FileEntry>, String> {
        let conn = self.connection(session_id).await?;

        let entries = conn
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("Failed to read remote directory: {e}"))?;

        let mut list = Vec::new();
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            // A READDIR name is a single path component; anything containing a
            // separator or NUL is a malicious/broken server trying to make a
            // recursive download escape the chosen local directory.
            if name.is_empty() || name.contains('/') || name.contains('\0') {
                eprintln!("[sftp] skipping invalid entry name from server: {name:?}");
                continue;
            }
            let file_type = entry.file_type();
            let is_dir = file_type.is_dir();
            let metadata = entry.metadata();
            let size = metadata.size.unwrap_or(0);
            let modified = metadata.mtime.map(|t| t as u64);
            let permissions = metadata.permissions;

            let full_path = if path.ends_with('/') {
                format!("{path}{name}")
            } else {
                format!("{path}/{name}")
            };

            list.push(FileEntry {
                name,
                path: full_path,
                is_dir,
                size,
                modified,
                permissions,
            });
        }

        // Sort: directories first, then alphabetical
        list.sort_by(|a, b| {
            if a.is_dir == b.is_dir {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            } else if a.is_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });

        Ok(list)
    }

    pub async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), String> {
        let conn = self.connection(session_id).await?;
        conn.sftp
            .create_dir(path)
            .await
            .map_err(|e| format!("Failed to create remote directory: {e}"))
    }

    pub async fn delete(&self, session_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        let conn = self.connection(session_id).await?;
        if is_dir {
            conn.sftp
                .remove_dir(path)
                .await
                .map_err(|e| format!("Failed to delete remote folder: {e}"))
        } else {
            conn.sftp
                .remove_file(path)
                .await
                .map_err(|e| format!("Failed to delete remote file: {e}"))
        }
    }

    pub async fn rename(&self, session_id: &str, old_path: &str, new_path: &str) -> Result<(), String> {
        let conn = self.connection(session_id).await?;
        conn.sftp
            .rename(old_path, new_path)
            .await
            .map_err(|e| format!("Failed to rename: {e}"))
    }

    /// Stat each path for the transfer-conflict check. A path that does not
    /// exist (or cannot be stat'ed) maps to `None` rather than failing the
    /// whole batch, so one unreadable entry never blocks the transfer.
    pub async fn stat_many(
        &self,
        session_id: &str,
        paths: &[String],
    ) -> Result<Vec<Option<FileEntry>>, String> {
        let conn = self.connection(session_id).await?;
        let mut result = Vec::with_capacity(paths.len());
        for path in paths {
            let entry = conn.sftp.metadata(path).await.ok().map(|md| FileEntry {
                name: Path::new(path)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone()),
                path: path.clone(),
                is_dir: md.is_dir(),
                size: md.size.unwrap_or(0),
                modified: md.mtime.map(|t| t as u64),
                permissions: md.permissions,
            });
            result.push(entry);
        }
        Ok(result)
    }

    pub async fn upload_file(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), String> {
        let conn = self.connection(session_id).await?;

        let total_bytes = tokio::fs::metadata(local_path)
            .await
            .map(|m| m.len())
            .map_err(|e| format!("Failed to read local file metadata: {e}"))?;

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("Failed to open local file: {e}"))?;

        let mut remote_file = conn
            .sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("Failed to create remote file: {e}"))?;

        on_progress(0, total_bytes);
        let mut bytes_done: u64 = 0;
        // One event per 64KB chunk would flood the IPC channel; ~10 updates
        // per second is smooth enough for a progress bar.
        let mut last_emit = Instant::now();
        let mut buffer = vec![0u8; 64 * 1024]; // 64KB chunks
        loop {
            let bytes_read = local_file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Error reading local file: {e}"))?;
            if bytes_read == 0 {
                break;
            }
            remote_file
                .write_all(&buffer[..bytes_read])
                .await
                .map_err(|e| format!("Error writing to remote file: {e}"))?;
            bytes_done += bytes_read as u64;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                on_progress(bytes_done, total_bytes);
                last_emit = Instant::now();
            }
        }
        remote_file
            .flush()
            .await
            .map_err(|e| format!("Error flushing remote file: {e}"))?;
        remote_file
            .shutdown()
            .await
            .map_err(|e| format!("Error closing remote file: {e}"))?;
        on_progress(total_bytes, total_bytes);

        Ok(())
    }

    pub async fn download_file(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), String> {
        let conn = self.connection(session_id).await?;

        let total_bytes = conn
            .sftp
            .metadata(remote_path)
            .await
            .ok()
            .and_then(|md| md.size)
            .unwrap_or(0);

        let mut remote_file = conn
            .sftp
            .open_with_flags(remote_path, OpenFlags::READ)
            .await
            .map_err(|e| format!("Failed to open remote file: {e}"))?;

        let mut local_file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| format!("Failed to create local file: {e}"))?;

        on_progress(0, total_bytes);
        let mut bytes_done: u64 = 0;
        let mut last_emit = Instant::now();
        let mut buffer = vec![0u8; 64 * 1024]; // 64KB chunks
        loop {
            let bytes_read = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Error reading remote file: {e}"))?;
            if bytes_read == 0 {
                break;
            }
            local_file
                .write_all(&buffer[..bytes_read])
                .await
                .map_err(|e| format!("Error writing to local file: {e}"))?;
            bytes_done += bytes_read as u64;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                on_progress(bytes_done, total_bytes);
                last_emit = Instant::now();
            }
        }
        local_file
            .flush()
            .await
            .map_err(|e| format!("Error flushing local file: {e}"))?;
        on_progress(total_bytes, total_bytes);

        Ok(())
    }

    pub async fn transfer_remote_to_remote(
        &self,
        src_session_id: &str,
        src_path: &str,
        dst_session_id: &str,
        dst_path: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(), String> {
        let src_conn = self.connection(src_session_id).await?;
        let dst_conn = self.connection(dst_session_id).await?;

        let total_bytes = src_conn
            .sftp
            .metadata(src_path)
            .await
            .ok()
            .and_then(|md| md.size)
            .unwrap_or(0);

        let mut src_file = src_conn
            .sftp
            .open_with_flags(src_path, OpenFlags::READ)
            .await
            .map_err(|e| format!("Failed to open source remote file: {e}"))?;

        let mut dst_file = dst_conn
            .sftp
            .open_with_flags(
                dst_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("Failed to create destination remote file: {e}"))?;

        on_progress(0, total_bytes);
        let mut bytes_done: u64 = 0;
        let mut last_emit = Instant::now();
        let mut buffer = vec![0u8; 64 * 1024]; // 64KB chunks
        loop {
            let bytes_read = src_file
                .read(&mut buffer)
                .await
                .map_err(|e| format!("Error reading from source server: {e}"))?;
            if bytes_read == 0 {
                break;
            }
            dst_file
                .write_all(&buffer[..bytes_read])
                .await
                .map_err(|e| format!("Error writing to destination server: {e}"))?;
            bytes_done += bytes_read as u64;
            if last_emit.elapsed() >= Duration::from_millis(100) {
                on_progress(bytes_done, total_bytes);
                last_emit = Instant::now();
            }
        }
        dst_file
            .flush()
            .await
            .map_err(|e| format!("Error flushing destination file: {e}"))?;
        dst_file
            .shutdown()
            .await
            .map_err(|e| format!("Error closing destination file: {e}"))?;
        on_progress(total_bytes, total_bytes);

        Ok(())
    }

    pub async fn read_text_file(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Result<String, String> {
        let conn = self.connection(session_id).await?;

        let metadata = conn
            .sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("Cannot read file metadata: {e}"))?;

        if let Some(size) = metadata.size {
            if size > 5 * 1024 * 1024 {
                return Err("File is too large to open in the inline editor (max 5 MB)".to_string());
            }
        }

        let mut file = conn
            .sftp
            .open_with_flags(remote_path, OpenFlags::READ)
            .await
            .map_err(|e| format!("Failed to open remote file: {e}"))?;

        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read remote file: {e}"))?;

        String::from_utf8(buffer)
            .map_err(|_| "File contains binary data and cannot be displayed as plain text".to_string())
    }

    pub async fn write_text_file(
        &self,
        session_id: &str,
        remote_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let conn = self.connection(session_id).await?;

        let mut file = conn
            .sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(|e| format!("Failed to open remote file for writing: {e}"))?;

        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to remote file: {e}"))?;

        file.flush()
            .await
            .map_err(|e| format!("Failed to flush remote file: {e}"))?;

        file.shutdown()
            .await
            .map_err(|e| format!("Failed to finalize remote file: {e}"))?;

        Ok(())
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let mut connections = self.connections.lock().await;
        connections.remove(session_id);
        Ok(())
    }
}

// Local filesystem helpers
pub fn list_local_directory(path: &Path) -> Result<Vec<FileEntry>, String> {
    let read_dir = fs::read_dir(path).map_err(|e| format!("Cannot read directory: {e}"))?;

    let mut entries = Vec::new();
    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();
        let metadata = entry.metadata().ok();

        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = metadata.and_then(|m| {
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()))
        });

        entries.push(FileEntry {
            name: file_name,
            path: file_path,
            is_dir,
            size,
            modified,
            permissions: None,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

/// Copy files the user chose in the system file picker into `dest_dir`,
/// returning the names they were saved under.
///
/// Android only: the picker returns `content://` URIs that are readable solely
/// through `ContentResolver`. Copying them into the local pane's folder turns
/// them into ordinary files the SFTP upload path already knows how to send.
/// Existing files are never overwritten; a clash gets a ` (n)` suffix.
#[cfg(target_os = "android")]
pub fn import_picked_files(uris: &[String], dest_dir: &str) -> Result<Vec<String>, String> {
    let dest_dir = Path::new(dest_dir);
    fs::create_dir_all(dest_dir).map_err(|e| format!("Cannot create {}: {e}", dest_dir.display()))?;

    let mut imported = Vec::with_capacity(uris.len());
    for uri in uris {
        let (name, mut source) = android_content::open_content_uri(uri)?;
        // The provider controls the display name: keep only its final path
        // component so it cannot point outside `dest_dir`.
        let name = name
            .as_deref()
            .and_then(|n| Path::new(n).file_name())
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty() && n != "." && n != "..")
            .unwrap_or_else(|| "imported-file".to_string());

        let target = unique_destination(dest_dir, &name);
        let mut out = fs::File::create(&target).map_err(|e| format!("Cannot create {}: {e}", target.display()))?;
        if let Err(e) = std::io::copy(&mut source, &mut out) {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(format!("Failed to copy {name}: {e}"));
        }
        imported.push(target.file_name().unwrap_or_default().to_string_lossy().to_string());
    }
    Ok(imported)
}

/// `dir/name`, or `dir/stem (n).ext` for the first `n` that is not taken.
#[cfg(any(target_os = "android", test))]
fn unique_destination(dir: &Path, name: &str) -> std::path::PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1u32..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("an unused file name exists")
}

/// Public `Download/Termimus` folder on Android, if this app can write there.
///
/// Since Android 11 (scoped storage) an app may create and manage its own
/// files in the shared Download collection through plain file paths, with no
/// permission. Files written here show up in the system Files app and are
/// kept when the app is uninstalled, unlike the sandbox. Older Android
/// versions require a storage permission we do not request, so the probe
/// below fails there and the caller falls back to the sandbox.
#[cfg(target_os = "android")]
fn android_public_download_dir() -> Option<std::path::PathBuf> {
    let root = std::env::var("EXTERNAL_STORAGE").unwrap_or_else(|_| "/storage/emulated/0".to_string());
    let dir = Path::new(&root).join("Download").join("Termimus");
    fs::create_dir_all(&dir).ok()?;
    // Creating the directory can succeed where writing a file does not.
    let probe = dir.join(".termimus-write-test");
    fs::write(&probe, b"").ok()?;
    let _ = fs::remove_file(&probe);
    Some(dir)
}

pub fn get_user_home() -> String {
    // Mobile apps have no readable home directory ("/" is permission-denied).
    #[cfg(mobile)]
    {
        #[cfg(target_os = "android")]
        if let Some(dir) = android_public_download_dir() {
            return dir.to_string_lossy().to_string();
        }
        // Fallback: a dedicated folder inside the sandbox rather than the app
        // data root, which holds the vault database and WebView internals
        // that a stray delete would destroy.
        let dir = crate::db::data_dir().join("transfers");
        let _ = std::fs::create_dir_all(&dir);
        dir.to_string_lossy().to_string()
    }
    #[cfg(desktop)]
    {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string())
    }
}

/// Stat each path for the transfer-conflict check; missing paths map to `None`.
pub fn stat_local_paths(paths: &[String]) -> Result<Vec<Option<FileEntry>>, String> {
    Ok(paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let metadata = fs::metadata(path).ok()?;
            Some(FileEntry {
                name: path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone()),
                path: p.clone(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
                permissions: None,
            })
        })
        .collect())
}

pub fn read_local_text_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Cannot read file metadata: {e}"))?;
    if metadata.len() > 5 * 1024 * 1024 {
        return Err("File is too large to open in the inline editor (max 5 MB)".to_string());
    }
    fs::read_to_string(path).map_err(|e| format!("Cannot read local file: {e}"))
}

pub fn write_local_text_file(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("Cannot write to local file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::unique_destination;
    use std::fs;

    #[test]
    fn unique_destination_never_reuses_an_existing_name() {
        let dir = std::env::temp_dir().join(format!("termimus-unique-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        assert_eq!(unique_destination(&dir, "notes.txt"), dir.join("notes.txt"));

        fs::write(dir.join("notes.txt"), b"").unwrap();
        assert_eq!(unique_destination(&dir, "notes.txt"), dir.join("notes (1).txt"));

        fs::write(dir.join("notes (1).txt"), b"").unwrap();
        assert_eq!(unique_destination(&dir, "notes.txt"), dir.join("notes (2).txt"));

        // No extension, and a dotfile whose whole name is the "stem".
        fs::write(dir.join("Makefile"), b"").unwrap();
        assert_eq!(unique_destination(&dir, "Makefile"), dir.join("Makefile (1)"));
        fs::write(dir.join(".env"), b"").unwrap();
        assert_eq!(unique_destination(&dir, ".env"), dir.join(".env (1)"));

        fs::remove_dir_all(&dir).unwrap();
    }
}
