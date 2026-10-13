use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

mod local_image;
mod native_menu;
mod recovery;
mod recent;
mod window_state;

const APP_TITLE: &str = "marky";

/// Largest document marky opens. Past this the read is refused instead of
/// filling memory with a file no editor can handle.
const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    path: Option<String>,
    name: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    path: Option<String>,
    name: Option<String>,
    /// Set when the file changed on disk and nothing was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict: Option<ConflictKind>,
}

/// How the file on disk differs from the version the app read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    Changed,
    Removed,
}

/// Fingerprint of an on-disk file, used to notice outside edits before writing.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

impl FileIdentity {
    fn read(path: &Path) -> io::Result<Self> {
        Ok(Self::from_metadata(&fs::metadata(path)?))
    }

    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }

    /// Stable string form, used by the frontend to de-duplicate prompts.
    fn token(&self) -> String {
        let modified = self
            .modified
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        #[cfg(unix)]
        let inode = self.inode;
        #[cfg(not(unix))]
        let inode = 0;
        format!("{}:{modified}:{inode}", self.length)
    }
}

/// On-disk fingerprints of the documents this window has read, so a save can
/// tell whether another program changed or removed the file in the meantime.
/// A read only *stages* its fingerprint; `adopt` promotes it once the frontend
/// actually replaces its buffer with that version.
#[derive(Default, Clone)]
struct DocumentIdentities {
    entries: Arc<Mutex<HashMap<String, FileIdentity>>>,
    pending: Arc<Mutex<HashMap<String, FileIdentity>>>,
}

impl DocumentIdentities {
    fn stage(&self, path: &str, identity: FileIdentity) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "Could not record the document's file identity".to_string())?
            .insert(path.to_string(), identity);
        Ok(())
    }

    /// Promotes the version a read staged, if any. A read whose result the
    /// frontend discarded (newer edits, another document) never becomes a save
    /// baseline, so the next save still reports the outside edit.
    fn adopt(&self, path: &str) {
        let staged = self.pending.lock().ok().and_then(|mut pending| pending.remove(path));
        if let (Some(identity), Ok(mut entries)) = (staged, self.entries.lock()) {
            entries.insert(path.to_string(), identity);
        }
    }

    /// Records the identity of the bytes this window last stored at `path`.
    fn remember(&self, path: &str, identity: FileIdentity) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(path.to_string(), identity);
        }
    }

    fn expected(&self, path: &str) -> Option<FileIdentity> {
        let entries = self.entries.lock().ok()?;
        entries.get(path).cloned()
    }
}

/// Paths the app itself chose: what the open and save dialogs returned, the
/// command-line argument, and a recent-file entry the native menu offered.
/// File commands only act on these, so a webview-script bug cannot turn them
/// into an arbitrary file read or write.
#[derive(Default, Clone)]
struct KnownPaths {
    paths: Arc<Mutex<HashSet<String>>>,
}

impl KnownPaths {
    /// Registers a path the app chose. A poisoned lock drops the registration
    /// rather than panicking: the worst case is a refused command, never a
    /// wrong file.
    fn add(&self, path: &str) {
        if let Ok(mut paths) = self.paths.lock() {
            paths.insert(path.to_string());
        }
    }

    /// Whether `path` came from the app itself.
    fn allows(&self, path: &str) -> bool {
        self.paths
            .lock()
            .map(|paths| paths.contains(path))
            .unwrap_or(false)
    }
}

/// Status of a tracked file, as reported to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStatus {
    /// `unchanged`, `changed`, `removed`, or `untracked` (never read).
    status: &'static str,
    /// Fingerprint of the current on-disk version (empty when untracked).
    token: String,
}

fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

/// Refuses a path the app never chose. `action` names the command so the
/// message reads naturally ("Could not open notes.md: ...").
pub(crate) fn require_known(known: &KnownPaths, action: &str, path: &str) -> Result<(), String> {
    if known.allows(path) {
        Ok(())
    } else {
        Err(format!(
            "Could not {action} {}: the window did not open or save this file",
            file_name_of(path)
        ))
    }
}

/// Registers the path a recent-file menu id names, so the file commands accept
/// a path the app itself stored. The id comes from the app's own menu, not the
/// renderer, so this is not a way for a webview to name an arbitrary file.
fn register_menu_path(known: &KnownPaths, action: &str) {
    if let Some(path) = action.strip_prefix("recent:") {
        known.add(path);
    }
}

/// The chosen location as a string. A location that is not a local file, or a
/// path that is not valid UTF-8, cannot cross the IPC boundary as a string:
/// refusing beats converting it lossily, which would name a different file.
fn chosen_path(file: FilePath) -> Result<String, String> {
    let path = file
        .into_path()
        .map_err(|error| format!("Could not use the chosen location: {error}"))?;
    path.to_str().map(str::to_owned).ok_or_else(|| {
        format!(
            "Could not use {}: the path is not valid UTF-8",
            path.display()
        )
    })
}

/// Reads content and its conflict baseline from the same open file.
fn read_tracked_document(identities: &DocumentIdentities, path: &str) -> Result<Document, String> {
    read_tracked_document_with(identities, path, |file| {
        let mut content = String::new();
        file.read_to_string(&mut content)?;
        Ok(content)
    })
}

fn read_tracked_document_with(
    identities: &DocumentIdentities,
    path: &str,
    read_content: impl FnOnce(&mut fs::File) -> io::Result<String>,
) -> Result<Document, String> {
    let read = || -> io::Result<(String, FileIdentity)> {
        let not_regular = || io::Error::new(io::ErrorKind::InvalidInput, "not a regular file");
        // Opening a FIFO blocks until a writer appears, and Windows refuses to
        // open a directory at all, so the type is checked before opening too.
        if !fs::metadata(path)?.is_file() {
            return Err(not_regular());
        }
        let mut file = fs::File::open(path)?;
        let metadata = file.metadata()?;
        // A directory, device or FIFO never ends: reading one would hang or
        // exhaust memory before any length check could reject it.
        if !metadata.file_type().is_file() {
            return Err(not_regular());
        }
        let identity = FileIdentity::from_metadata(&metadata);
        if identity.length > MAX_DOCUMENT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "file is {} bytes, which is larger than the {} byte limit",
                    identity.length, MAX_DOCUMENT_BYTES
                ),
            ));
        }
        let content = read_content(&mut file)?;
        let after = FileIdentity::from_metadata(&file.metadata()?);
        if identity != after || content.len() as u64 != identity.length {
            return Err(io::Error::other(
                "File changed while being read; open it again",
            ));
        }
        Ok((content, identity))
    };
    let (content, identity) =
        read().map_err(|e| format!("Could not open {}: {e}", file_name_of(path)))?;
    // Do not stat the pathname here: it may now refer to a replacement file.
    // The fingerprint stays staged until the frontend adopts this version.
    identities.stage(path, identity)?;
    Ok(Document {
        path: Some(path.to_string()),
        name: file_name_of(path),
        content,
    })
}

fn detect_conflict(expected: &FileIdentity, path: &Path) -> Option<ConflictKind> {
    match FileIdentity::read(path) {
        Ok(current) if current == *expected => None,
        Ok(_) => Some(ConflictKind::Changed),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Some(ConflictKind::Removed),
        // An unreadable file cannot be verified; refuse to overwrite it.
        Err(_) => Some(ConflictKind::Changed),
    }
}

/// The conflict that should stop a save from overwriting another program's
/// version of the file, if any.
fn save_conflict(identities: &DocumentIdentities, path: &str, force: bool) -> Option<ConflictKind> {
    if force {
        return None;
    }
    let expected = identities.expected(path)?;
    detect_conflict(&expected, Path::new(path))
}

/// Holds an exclusive advisory lock on the document that is about to be checked
/// and written, so two instances cannot both pass the conflict check and then
/// overwrite each other's save. The destination file itself is locked: aliases
/// and symlinks resolve to the same inode, so no lock files are left beside the
/// user's documents. A file that is absent (a first save) or that cannot be
/// locked has no version to protect, and the save proceeds without a lock.
fn lock_destination(path: &Path) -> Option<File> {
    let file = OpenOptions::new().read(true).open(path).ok()?;
    file.lock().ok()?;
    Some(file)
}

/// Writes `content` unless the file changed on disk since it was read, in
/// which case nothing is written and the conflict is returned for the UI.
fn save_to_path(
    identities: &DocumentIdentities,
    path: &str,
    content: &str,
    force: bool,
) -> io::Result<Option<ConflictKind>> {
    // Held until this save finishes, so the check and the write cannot
    // interleave with another instance saving the same document.
    let _guard = lock_destination(Path::new(path));
    if let Some(conflict) = save_conflict(identities, path, force) {
        return Ok(Some(conflict));
    }
    match atomic_write(Path::new(path), content) {
        Ok(identity) => {
            identities.remember(path, identity);
            Ok(None)
        }
        // The file already holds the new content: keep the baseline in step
        // with it, so retrying does not report a conflict with our own write.
        Err(WriteFailure::Committed(error, identity)) => {
            identities.remember(path, identity);
            Err(error)
        }
        Err(WriteFailure::Uncommitted(error)) => Err(error),
    }
}

fn document_status(identities: &DocumentIdentities, path: &str) -> DocumentStatus {
    let expected = match identities.expected(path) {
        Some(expected) => expected,
        None => {
            return DocumentStatus {
                status: "untracked",
                token: String::new(),
            }
        }
    };
    match FileIdentity::read(Path::new(path)) {
        Ok(current) if current == expected => DocumentStatus {
            status: "unchanged",
            token: current.token(),
        },
        Ok(current) => DocumentStatus {
            status: "changed",
            token: current.token(),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => DocumentStatus {
            status: "removed",
            token: "removed".to_string(),
        },
        Err(_) => DocumentStatus {
            status: "changed",
            token: "unreadable".to_string(),
        },
    }
}

fn startup_document_from_argument(
    identities: &DocumentIdentities,
    argument: Option<&str>,
) -> Result<Option<Document>, String> {
    match argument {
        None => Ok(None),
        Some(path) => read_tracked_document(identities, path).map(Some),
    }
}

/// Document passed on the command line (`marky notes.md`), if any.
#[tauri::command]
async fn startup_document(
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
) -> Result<Option<Document>, String> {
    let identities = state.inner().clone();
    let known = known.inner().clone();
    let argument = std::env::args().nth(1);
    off_main_thread("Startup document", move || {
        // The command line chose this path; later commands may name it.
        if let Some(path) = argument.as_deref() {
            known.add(path);
        }
        startup_document_from_argument(&identities, argument.as_deref())
    })
    .await
}

#[tauri::command]
async fn open_document(
    app: AppHandle,
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
) -> Result<Option<Document>, String> {
    let identities = state.inner().clone();
    let known = known.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("All files", &["*"])
            .blocking_pick_file();
        match picked {
            Some(file) => {
                let path = chosen_path(file)?;
                // The dialog chose this path; later commands may name it.
                known.add(&path);
                read_tracked_document(&identities, &path).map(Some)
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("Open failed: {e}"))?
}

/// Re-reads a known path, used when adopting a file that changed on disk.
#[tauri::command]
async fn load_document(
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
    path: String,
) -> Result<Document, String> {
    require_known(&known, "open", &path)?;
    let identities = state.inner().clone();
    off_main_thread("Open document", move || read_tracked_document(&identities, &path)).await
}

/// Records the version the frontend just adopted as this document's save
/// baseline. A read that was superseded by newer edits must never become the
/// baseline, or the next save would overwrite the outside version unnoticed.
/// Only the in-memory identity map changes, so this needs no thread hop.
#[tauri::command]
fn adopt_document(
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
    path: String,
) -> Result<(), String> {
    require_known(&known, "open", &path)?;
    state.adopt(&path);
    Ok(())
}

/// Reports whether the file still matches the version the app read. This runs
/// on every window focus change, so the stat happens off the calling thread.
#[tauri::command]
async fn check_document(
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
    path: String,
) -> Result<DocumentStatus, String> {
    require_known(&known, "check", &path)?;
    let identities = state.inner().clone();
    off_main_thread("Document check", move || Ok(document_status(&identities, &path))).await
}

#[cfg(unix)]
fn read_extended_attributes(path: &Path) -> io::Result<Vec<(std::ffi::OsString, Vec<u8>)>> {
    let mut attributes = Vec::new();
    for name in xattr::list_deref(path)? {
        // Do not carry capabilities or content signatures onto changed bytes.
        if matches!(
            name.to_str(),
            Some("security.capability" | "security.ima" | "security.evm")
        ) {
            continue;
        }
        if let Some(value) = xattr::get_deref(path, &name)? {
            attributes.push((name, value));
        }
    }
    Ok(attributes)
}

#[cfg(unix)]
fn write_extended_attributes(
    path: &Path,
    attributes: &[(std::ffi::OsString, Vec<u8>)],
) -> io::Result<()> {
    for (name, value) in attributes {
        xattr::set_deref(path, name, value)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn read_extended_attributes(_: &Path) -> io::Result<Vec<(std::ffi::OsString, Vec<u8>)>> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(not(unix))]
fn write_extended_attributes(_: &Path, _: &[(std::ffi::OsString, Vec<u8>)]) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

/// How a failed write left the file. The caller only needs to know whether the
/// replacement is already committed, so it can keep the save baseline in step
/// with what is on disk while still reporting the failure.
#[derive(Debug)]
enum WriteFailure {
    /// The failure happened before the replacement was committed; the file may
    /// hold neither version, so no new baseline may be recorded for it.
    Uncommitted(io::Error),
    /// The file holds the new content; the error is only about whether its
    /// directory entry survives a crash. The identity describes those bytes.
    Committed(io::Error, FileIdentity),
}

impl From<io::Error> for WriteFailure {
    fn from(error: io::Error) -> Self {
        WriteFailure::Uncommitted(error)
    }
}

impl WriteFailure {
    fn into_io(self) -> io::Error {
        match self {
            WriteFailure::Uncommitted(error) | WriteFailure::Committed(error, _) => error,
        }
    }
}

/// Writes in place (the file cannot be replaced) and reports the identity of
/// the bytes stored, read from the open descriptor.
fn write_in_place(path: &Path, content: &str) -> Result<FileIdentity, WriteFailure> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(content.as_bytes())?;
    let identity = FileIdentity::from_metadata(&file.metadata()?);
    match file.sync_all() {
        Ok(()) => Ok(identity),
        Err(error) => Err(WriteFailure::Committed(error, identity)),
    }
}

fn canonicalize_for_write(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = fs::read_link(path)?;
                let target_path = if target.is_absolute() {
                    target
                } else {
                    path.parent()
                        .filter(|parent| !parent.as_os_str().is_empty())
                        .unwrap_or_else(|| Path::new("."))
                        .join(target)
                };
                canonicalize_for_write(&target_path)
            }
            Err(metadata_error) if metadata_error.kind() == io::ErrorKind::NotFound => {
                let file_name = path.file_name().ok_or(error)?;
                let parent = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new("."));
                Ok(fs::canonicalize(parent)?.join(file_name))
            }
            Ok(_) => Err(error),
            Err(metadata_error) => Err(metadata_error),
        },
        Err(error) => Err(error),
    }
}

/// Replaces `path` with `content` and reports the identity of the stored
/// bytes. That identity comes from the written descriptor, never from a later
/// stat of the pathname, which another writer may already have replaced.
fn atomic_write(path: &Path, content: &str) -> Result<FileIdentity, WriteFailure> {
    atomic_write_with(path, content, read_extended_attributes)
}

/// Replaces `path` with `content`, carrying the extended attributes that
/// `read_attributes` reports. The reader is injected so a filesystem without
/// extended-attribute support can be exercised without one.
fn atomic_write_with(
    path: &Path,
    content: &str,
    read_attributes: impl Fn(&Path) -> io::Result<Vec<(std::ffi::OsString, Vec<u8>)>>,
) -> Result<FileIdentity, WriteFailure> {
    let write_path = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => canonicalize_for_write(path)?,
        Ok(_) => path.to_path_buf(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
        Err(error) => return Err(WriteFailure::Uncommitted(error)),
    };
    let parent = write_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if write_path.file_name().is_none() {
        return Err(WriteFailure::Uncommitted(io::Error::new(
            io::ErrorKind::InvalidInput,
            "save path has no file name",
        )));
    }
    let metadata = match fs::metadata(&write_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(WriteFailure::Uncommitted(error)),
    };

    if metadata
        .as_ref()
        .is_some_and(|metadata| metadata.permissions().readonly())
    {
        return Err(WriteFailure::Uncommitted(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cannot overwrite a read-only file",
        )));
    }

    #[cfg(unix)]
    if metadata
        .as_ref()
        .is_some_and(|metadata| metadata.nlink() > 1)
    {
        return write_in_place(&write_path, content);
    }

    let attributes = match metadata.as_ref() {
        Some(_) => match read_attributes(&write_path) {
            Ok(attributes) => Some(attributes),
            // A filesystem that cannot store extended attributes has none to
            // preserve, so the replacement stays atomic. Any other failure may
            // hide metadata this write cannot copy, so the file is rewritten in
            // place instead of being replaced.
            Err(error) if error.kind() == io::ErrorKind::Unsupported => None,
            Err(_) => return write_in_place(&write_path, content),
        },
        None => None,
    };

    for _ in 0..128 {
        let temp_name = format!(
            ".marky-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
        );
        let temp_path = parent.join(temp_name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);

        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

            let mode = metadata
                .as_ref()
                .map(|metadata| metadata.permissions().mode())
                .unwrap_or(0o666);
            options.mode(mode);
        }

        let mut file = match options.open(&temp_path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            // The directory refuses a new entry, but the file itself may still
            // be writable: fall back rather than fail a save that can work.
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
                ) =>
            {
                return write_in_place(&write_path, content);
            }
            Err(error) => return Err(WriteFailure::Uncommitted(error)),
        };

        #[cfg(unix)]
        if let Some(existing_metadata) = &metadata {
            let temporary_metadata = match file.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    drop(file);
                    let _ = fs::remove_file(&temp_path);
                    return Err(WriteFailure::Uncommitted(error));
                }
            };
            if existing_metadata.uid() != temporary_metadata.uid()
                || existing_metadata.gid() != temporary_metadata.gid()
            {
                drop(file);
                let _ = fs::remove_file(&temp_path);
                return write_in_place(&write_path, content);
            }
        }

        if let Err(error) = file.write_all(content.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(WriteFailure::Uncommitted(error));
        }

        if let Some(attributes) = &attributes {
            match write_extended_attributes(&temp_path, attributes) {
                Ok(()) => {}
                // The replacement cannot store them either: the atomic write
                // matters more than a copy the filesystem cannot keep.
                Err(error) if error.kind() == io::ErrorKind::Unsupported => {}
                Err(_) => {
                    drop(file);
                    let _ = fs::remove_file(&temp_path);
                    return write_in_place(&write_path, content);
                }
            }
        }

        if let Some(metadata) = &metadata {
            match file.set_permissions(metadata.permissions()) {
                Ok(()) => {}
                // A filesystem that cannot store modes has none to preserve.
                Err(error) if error.kind() == io::ErrorKind::Unsupported => {}
                Err(_) => {
                    drop(file);
                    let _ = fs::remove_file(&temp_path);
                    return write_in_place(&write_path, content);
                }
            }
        }
        if let Err(error) = file.sync_all() {
            drop(file);
            let _ = fs::remove_file(&temp_path);
            return Err(WriteFailure::Uncommitted(error));
        }
        let identity = match file.metadata() {
            Ok(metadata) => FileIdentity::from_metadata(&metadata),
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&temp_path);
                return Err(WriteFailure::Uncommitted(error));
            }
        };
        drop(file);

        if let Err(error) = fs::rename(&temp_path, &write_path) {
            let _ = fs::remove_file(&temp_path);
            return Err(WriteFailure::Uncommitted(error));
        }
        // The replacement is already committed: only its durability is in
        // doubt, so the caller still records the identity it reports here.
        if let Err(error) = sync_directory(parent) {
            return Err(WriteFailure::Committed(error, identity));
        }
        return Ok(identity);
    }

    Err(WriteFailure::Uncommitted(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a temporary save file",
    )))
}

/// Sync the directory entry so a completed rename survives power loss.
/// The standard library cannot open directories on Windows, so only Unix can
/// enforce this.
#[cfg(unix)]
fn sync_directory(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> io::Result<()> {
    Ok(())
}

#[tauri::command]
async fn save_document(
    app: AppHandle,
    state: tauri::State<'_, DocumentIdentities>,
    known: tauri::State<'_, KnownPaths>,
    path: Option<String>,
    content: String,
    force: bool,
) -> Result<SaveOutcome, String> {
    let known = known.inner().clone();
    // No known path: raise the save dialog (Save As).
    let target = match path {
        Some(p) => {
            require_known(&known, "save", &p)?;
            Some(p)
        }
        None => {
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .add_filter("Markdown", &["md", "markdown"])
                    .set_file_name("Untitled.md")
                    .blocking_save_file()
            })
            .await
            .map_err(|e| format!("Save failed: {e}"))?
            .map(chosen_path)
            .transpose()?;
            // The save dialog chose this path; later saves may name it directly.
            if let Some(path) = &picked {
                known.add(path);
            }
            picked
        }
    };

    match target {
        Some(p) => {
            let save_name = file_name_of(&p);
            let identities = state.inner().clone();
            let target = p.clone();
            let write_result = tauri::async_runtime::spawn_blocking(move || {
                save_to_path(&identities, &target, &content, force)
            })
            .await
            .map_err(|error| format!("Could not save {save_name}: {error}"))?;
            let conflict =
                write_result.map_err(|error| format!("Could not save {save_name}: {error}"))?;
            Ok(SaveOutcome {
                path: Some(p),
                name: Some(save_name),
                conflict,
            })
        }
        // Dialog cancelled: report "nothing saved" so the document stays dirty.
        None => Ok(SaveOutcome {
            path: None,
            name: None,
            conflict: None,
        }),
    }
}

#[tauri::command]
fn set_window_title(app: AppHandle, name: String, dirty: bool) -> Result<(), String> {
    let marker = if dirty { "* " } else { "" };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Could not set window title: main window is missing".to_string())?;
    window
        .set_title(&format!("{marker}{name} — {APP_TITLE}"))
        .map_err(|e| format!("Could not set window title: {e}"))
}

/// Runs a filesystem operation off the calling thread. The work is small, but
/// a command that blocks the thread answering the window freezes it for as
/// long as the operation takes (a slow or hung mount holds it for seconds).
async fn off_main_thread<T, F>(task: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(operation).await {
        Ok(result) => result,
        Err(error) => Err(format!("{task} failed: {error}")),
    }
}

/// Persists a private crash-recovery snapshot. The backend assigns
/// `updatedAt` and holds the per-id advisory lock for the session.
#[tauri::command]
async fn write_recovery(
    store: tauri::State<'_, recovery::RecoveryStore>,
    snapshot: recovery::RecoveryWrite,
) -> Result<(), String> {
    let store = store.inner().clone();
    let id = snapshot.id.clone();
    off_main_thread("recovery task", move || {
        store
            .write(&snapshot)
            .map_err(|e| format!("failed to write recovery snapshot {id}: {e}"))
    })
    .await
}

/// Lists orphan snapshots left by crashed instances as metadata summaries
/// (newest first), so the startup prompt never ships every snapshot's text.
/// Unreadable snapshots are reported in `errors` and stay on disk untouched.
#[tauri::command]
async fn list_recovery(
    store: tauri::State<'_, recovery::RecoveryStore>,
) -> Result<recovery::RecoveryListing, String> {
    let store = store.inner().clone();
    off_main_thread("recovery task", move || Ok(store.list())).await
}

/// Returns the content of one recovery snapshot so the frontend can restore
/// it. Refuses a non-canonical id and an id with no snapshot file; nothing is
/// deleted, because recovery files are the user's unsaved writing.
#[tauri::command]
async fn read_recovery(
    store: tauri::State<'_, recovery::RecoveryStore>,
    id: String,
) -> Result<recovery::RecoverySnapshot, String> {
    let store = store.inner().clone();
    off_main_thread("recovery task", move || {
        store
            .read(&id)
            .map_err(|e| format!("failed to read recovery snapshot {id}: {e}"))
    })
    .await
}

/// Deletes exactly the recovery snapshot with this id; snapshots live in
/// another instance are refused and absent ids are a no-op.
#[tauri::command]
async fn discard_recovery(
    store: tauri::State<'_, recovery::RecoveryStore>,
    id: String,
) -> Result<(), String> {
    let store = store.inner().clone();
    off_main_thread("recovery task", move || {
        store
            .discard(&id)
            .map_err(|e| format!("failed to discard recovery snapshot {id}: {e}"))
    })
    .await
}

/// Drops this instance's claim on a deferred startup snapshot without
/// deleting it.
#[tauri::command]
async fn release_recovery(
    store: tauri::State<'_, recovery::RecoveryStore>,
    id: String,
) -> Result<(), String> {
    let store = store.inner().clone();
    off_main_thread("recovery task", move || {
        store
            .release(&id)
            .map_err(|e| format!("failed to release recovery snapshot {id}: {e}"))
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Keep KDE from substituting the installed launcher's icon for dev windows.
    #[cfg(all(target_os = "linux", debug_assertions))]
    gtk::glib::set_prgname(Some("marky-dev"));
    // NVIDIA Wayland: webkit2gtk crashes or renders a dead webview
    // (Gdk protocol error / GBM buffer failure) without this workaround,
    // matching the dev recipe in the justfile. Must be set before the
    // web context is created, so it is set at process start.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    tauri::Builder::default()
        .manage(DocumentIdentities::default())
        .manage(KnownPaths::default())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(local_image::SCHEME, |_, request, responder| {
            // Reading the file must not hold up the thread answering the window.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(local_image::respond(&request))
            });
        })
        .invoke_handler(tauri::generate_handler![
            startup_document,
            open_document,
            load_document,
            adopt_document,
            check_document,
            save_document,
            recent::refresh_recent_documents,
            recent::remember_document,
            recent::clear_recent_documents,
            set_window_title,
            native_menu::set_menu_palette,
            write_recovery,
            list_recovery,
            read_recovery,
            discard_recovery,
            release_recovery
        ])
        .on_menu_event(|app, event| {
            let action = event.id().as_ref();
            if let Some(known) = app.try_state::<KnownPaths>() {
                register_menu_path(&known, action);
            }
            let _ = app.emit("menu-action", action);
        })
        .setup(|app| {
            let recovery_root = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot resolve app data directory: {e}"))?
                .join("recovery");
            let recovery_store = recovery::RecoveryStore::new(recovery_root)
                .map_err(|e| format!("cannot open recovery store: {e}"))?;
            app.manage(recovery_store);
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::*;

                let window = app.get_webview_window("main").ok_or("main window is missing")?;
                let gtk_window = window.gtk_window()?;
                if let Some(titlebar) = gtk_window
                    .titlebar()
                    .and_then(|bar| bar.downcast::<gtk::EventBox>().ok())
                {
                    // Tao stacks this event window above the HeaderBar, where it
                    // intercepts pointer input meant for the titlebar buttons.
                    titlebar.set_above_child(false);
                    // Tao's Wayland header has its own title, separate from the window.
                    if let Some(header) = titlebar
                        .child()
                        .and_then(|child| child.downcast::<gtk::HeaderBar>().ok())
                    {
                        gtk_window
                            .bind_property("title", &header, "title")
                            .sync_create()
                            .build();
                    }
                }

                // WebKit's default context menu carries entries that mean
                // nothing in a markdown document. Items are matched by stock
                // action rather than label, so the filter holds for any
                // translation.
                const UNHELPFUL_MENU_ACTIONS: [webkit2gtk::ContextMenuAction; 1] =
                    [webkit2gtk::ContextMenuAction::Unicode];
                window.with_webview(|platform| {
                    use webkit2gtk::{ContextMenuExt, ContextMenuItemExt, WebViewExt};

                    platform.inner().connect_context_menu(
                        move |_view, menu, _event, _hit_test| {
                            for item in menu.items() {
                                if UNHELPFUL_MENU_ACTIONS.contains(&item.stock_action()) {
                                    menu.remove(&item);
                                }
                            }
                            // Show the menu WebKit was about to show, filtered.
                            false
                        },
                    );
                })?;
            }

            let recent_menu = SubmenuBuilder::new(app, "Recent Files")
                .item(
                    &MenuItemBuilder::with_id("recent-empty", "No recent files")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?;
            let recent_store =
                recent::RecentStore::new(app.path().app_data_dir()?.join("recent-files"))?;
            app.manage(recent::RecentDocuments {
                store: recent_store,
                menu: recent_menu.clone(),
            });
            let file = SubmenuBuilder::new(app, "File")
                .text("new", "New")
                .text("open", "Open…")
                .item(&recent_menu)
                .text("save", "Save")
                .text("save-as", "Save As…")
                .text("front-matter", "Front Matter…")
                .separator()
                .text("close", "Close Window")
                .build()?;

            let edit = SubmenuBuilder::new(app, "Edit")
                .text("undo", "Undo")
                .text("redo", "Redo")
                .separator()
                .text("find", "Find/Replace (Ctrl+F)")
                .text("cut", "Cut")
                .text("copy", "Copy")
                .text("paste", "Paste")
                .text("select-all", "Select All")
                .build()?;

            let font_menu = SubmenuBuilder::new(app, "Font")
                .text("font-system", "System Sans")
                .text("font-serif", "Serif")
                .text("font-mono", "Monospace")
                .separator()
                .text("font-size-small", "Small")
                .text("font-size-medium", "Medium")
                .text("font-size-large", "Large")
                .build()?;
            let theme_menu = SubmenuBuilder::new(app, "Theme")
                .text("theme-light", "Light")
                .text("theme-sepia", "Sepia")
                .text("theme-solarized", "Solarized Light")
                .text("theme-dark", "Dark")
                .text("theme-nord", "Nord")
                .text("theme-dracula", "Dracula")
                .text("theme-catppuccin", "Catppuccin")
                .text("theme-tokyo-night", "Tokyo Night")
                .build()?;
            let appearance_menu = SubmenuBuilder::new(app, "Appearance")
                .text("theme", "Next Theme (F9)")
                .separator()
                .item(&theme_menu)
                .item(&font_menu)
                .build()?;
            let view = SubmenuBuilder::new(app, "View")
                .text("outline", "Outline (F6)")
                .text("focus", "Focus Mode (F8)")
                .separator()
                .text("raw", "Raw Mode (Ctrl+/)")
                .text("spell", "Spell & Grammar Check (F7)")
                .text("remote-images", "Remote Images")
                .build()?;

            let alert = SubmenuBuilder::new(app, "Alert")
                .text("insert-alert-note", "Note")
                .text("insert-alert-tip", "Tip")
                .text("insert-alert-important", "Important")
                .text("insert-alert-warning", "Warning")
                .text("insert-alert-caution", "Caution")
                .build()?;
            let insert = SubmenuBuilder::new(app, "Insert")
                .text("insert-table", "Table…")
                .text("insert-hr", "Horizontal Line")
                .text("insert-code-block", "Code Block")
                .item(&alert)
                .text("insert-footnote", "Footnote")
                .text("insert-toc", "Table of Contents")
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file, &edit, &insert, &view, &appearance_menu])
                .build()?;
            app.set_menu(menu)?;
            let window = app.get_webview_window("main").ok_or("main window is missing")?;
            window_state::install(&window, app.path().app_data_dir()?.join("window-state.json"))?;
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, document_status, lock_destination, MAX_DOCUMENT_BYTES, off_main_thread,
        read_tracked_document, read_tracked_document_with, register_menu_path, require_known,
        save_to_path, startup_document_from_argument, sync_directory, ConflictKind,
        DocumentIdentities, FileIdentity, KnownPaths,
    };
    #[cfg(unix)]
    use super::{atomic_write_with, chosen_path, FilePath};
    use std::fs;
    #[cfg(unix)]
    use std::io;
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique directory per call: tests run in parallel, and two of them can
    /// read the same clock value, which made this helper collide.
    fn temporary_directory() -> std::path::PathBuf {
        static NEXT_DIRECTORY: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let unique = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "marky-atomic-save-{}-{nonce}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    /// Stands in for the frontend adopting the version it just put in a buffer.
    fn track(identities: &DocumentIdentities, path: &str) {
        identities.remember(path, FileIdentity::read(std::path::Path::new(path)).unwrap());
    }

    /// A webview bug must not be able to name a file the app never chose.
    #[test]
    fn known_paths_accepts_only_registered_paths() {
        let known = KnownPaths::default();
        assert!(!known.allows("/notes/notes.md"));
        known.add("/notes/notes.md");
        assert!(known.allows("/notes/notes.md"));

        // A refused command must not widen the registry.
        let refused = require_known(&known, "open", "/etc/passwd").unwrap_err();
        assert!(refused.contains("passwd"), "message was {refused:?}");
        assert!(refused.contains("did not open or save this file"));
        assert!(!known.allows("/etc/passwd"));

        // The command names the verb, so a save refusal reads as a save.
        let refused_save = require_known(&known, "save", "/etc/shadow").unwrap_err();
        assert!(
            refused_save.starts_with("Could not save shadow:"),
            "message was {refused_save:?}"
        );
        assert!(!known.allows("/etc/shadow"));

        assert!(require_known(&known, "open", "/notes/notes.md").is_ok());
    }

    /// Only a recent-file click registers a path; other menu actions do not.
    #[test]
    fn only_recent_menu_actions_register_a_path() {
        let known = KnownPaths::default();
        register_menu_path(&known, "recent:/notes/notes.md");
        assert!(known.allows("/notes/notes.md"));
        // A path smuggled into another action id is not registered.
        register_menu_path(&known, "open:/etc/passwd");
        assert!(!known.allows("/etc/passwd"));
        assert!(!known.allows("open:/etc/passwd"));
        // The recent submenu's own items register nothing.
        register_menu_path(&known, "recent-clear");
        assert!(!known.allows("recent-clear"));
    }

    #[test]
    fn sync_directory_opens_real_directories() {
        let directory = temporary_directory();
        assert!(sync_directory(&directory).is_ok());
        #[cfg(unix)]
        assert!(sync_directory(&directory.join("missing")).is_err());
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn atomic_write_replaces_existing_file_contents() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();

        let result = atomic_write(&path, "new content");
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents, "new content");
    }

    #[test]
    fn atomic_write_keeps_existing_target_when_replacement_fails() {
        let directory = temporary_directory();
        let target = directory.join("notes.md");
        fs::create_dir(&target).unwrap();

        let result = atomic_write(&target, "new content");
        let target_is_directory = target.is_dir();
        let entry_count = fs::read_dir(&directory).unwrap().count();
        fs::remove_dir_all(directory).unwrap();

        assert!(result.is_err());
        assert!(target_is_directory);
        assert_eq!(entry_count, 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_symlink_targets() {
        use std::os::unix::fs::symlink;

        let directory = temporary_directory();
        let target = directory.join("target.md");
        let link = directory.join("notes.md");
        fs::write(&target, "old content").unwrap();
        symlink(&target, &link).unwrap();

        let result = atomic_write(&link, "new content");
        let contents = fs::read_to_string(&target).unwrap();
        let link_is_symlink = fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents, "new content");
        assert!(link_is_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_creates_dangling_symlink_target() {
        use std::os::unix::fs::symlink;

        let directory = temporary_directory();
        let target = directory.join("target.md");
        let link = directory.join("notes.md");
        symlink("target.md", &link).unwrap();

        let result = atomic_write(&link, "new content");
        let contents = fs::read_to_string(&target).ok();
        let link_is_symlink = fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents.as_deref(), Some("new content"));
        assert!(link_is_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temporary_directory();
        let path = directory.join("private.md");
        fs::write(&path, "old content").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let result = atomic_write(&path, "new content");
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_does_not_replace_read_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temporary_directory();
        let path = directory.join("readonly.md");
        fs::write(&path, "old content").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

        let result = atomic_write(&path, "new content");
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(
            result.unwrap_err().into_io().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(contents, "old content");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_updates_all_hard_link_names() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        let alias = directory.join("alias.md");
        fs::write(&path, "old content").unwrap();
        fs::hard_link(&path, &alias).unwrap();

        let result = atomic_write(&path, "new content");
        let alias_contents = fs::read_to_string(&alias).unwrap();
        let reported = result.unwrap();
        let on_disk = FileIdentity::read(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(alias_contents, "new content");
        assert_eq!(reported, on_disk, "an in-place write reports what it stored");
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_extended_attributes() {
        use std::os::unix::fs::MetadataExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();
        if let Err(error) = xattr::set(&path, "user.marky-test", b"saved metadata") {
            fs::remove_dir_all(directory).unwrap();
            if error.kind() == std::io::ErrorKind::Unsupported {
                return;
            }
            panic!("could not prepare extended-attribute test: {error}");
        }

        let result = atomic_write(&path, "new content");
        let value = xattr::get(&path, "user.marky-test").unwrap();
        let new_inode = fs::metadata(&path).unwrap().ino();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_ne!(new_inode, old_inode);
        assert_eq!(value.as_deref(), Some(b"saved metadata".as_slice()));
    }

    /// A filesystem that cannot store extended attributes has none to preserve,
    /// so the save must still replace the file rather than truncate it.
    #[cfg(unix)]
    #[test]
    fn atomic_write_replaces_the_file_where_extended_attributes_are_unsupported() {
        use std::os::unix::fs::MetadataExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        let result = atomic_write_with(&path, "new content", |_| {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        });
        let new_inode = fs::metadata(&path).unwrap().ino();
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents, "new content");
        assert_ne!(new_inode, old_inode, "the file must be replaced, not truncated");
    }

    /// A filesystem that cannot store an attribute has none to preserve, so the
    /// replacement still happens. A bogus namespace reaches that arm with the
    /// real writer: `setxattr` answers EOPNOTSUPP for it.
    #[cfg(unix)]
    #[test]
    fn atomic_write_replaces_the_file_when_an_attribute_cannot_be_stored() {
        use std::os::unix::fs::MetadataExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        let result = atomic_write_with(&path, "new content", |_| {
            Ok(vec![(
                std::ffi::OsString::from("bogus.marky-test"),
                b"value".to_vec(),
            )])
        });
        let new_inode = fs::metadata(&path).unwrap().ino();
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents, "new content");
        assert_ne!(new_inode, old_inode, "the file must be replaced, not truncated");
    }

    /// A refusal that is not "unsupported" may hide metadata the copy cannot
    /// carry, so the file keeps its inode. `trusted.*` answers EPERM.
    #[cfg(unix)]
    #[test]
    fn atomic_write_stays_in_place_when_an_attribute_is_denied() {
        use std::os::unix::fs::MetadataExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        let result = atomic_write_with(&path, "new content", |_| {
            Ok(vec![(
                std::ffi::OsString::from("trusted.marky-test"),
                b"value".to_vec(),
            )])
        });
        let new_inode = fs::metadata(&path).unwrap().ino();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(new_inode, old_inode);
    }

    /// A file the user can write inside a directory they cannot: the save must
    /// still succeed, which it can only do by writing in place. The directory's
    /// write bit is what blocks the temp file, so this needs a non-root run.
    #[cfg(unix)]
    #[test]
    fn a_writable_file_in_a_read_only_directory_is_saved_in_place() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();

        let identities = DocumentIdentities::default();
        let result = save_to_path(&identities, &path.to_string_lossy(), "new content", false);

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        let new_inode = fs::metadata(&path).unwrap().ino();
        let entries: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(contents, "new content");
        assert_eq!(new_inode, old_inode, "the file is written in place");
        assert_eq!(entries.len(), 1, "no temp file may be left behind: {entries:?}");
    }

    /// Any other read failure may hide metadata the write cannot copy, so the
    /// file keeps its inode: an in-place write preserves what it cannot read.
    #[cfg(unix)]
    #[test]
    fn atomic_write_stays_in_place_when_attributes_cannot_be_read() {
        use std::os::unix::fs::MetadataExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let old_inode = fs::metadata(&path).unwrap().ino();

        let result = atomic_write_with(&path, "new content", |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        let new_inode = fs::metadata(&path).unwrap().ino();
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(new_inode, old_inode);
    }

    /// The thread answering the window must not be the one that touches the
    /// filesystem: a slow or hung mount would freeze the window for as long as
    /// the operation takes.
    #[test]
    fn filesystem_commands_run_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(off_main_thread("Test", || {
            Ok(std::thread::current().id())
        }))
        .unwrap();
        assert_ne!(worker, caller);
    }

    /// A directory, device or FIFO never ends: reading one would hang or
    /// exhaust memory before any length check could reject it.
    #[test]
    fn reading_something_that_is_not_a_regular_file_is_refused() {
        let directory = temporary_directory();
        let path = directory.to_string_lossy().into_owned();
        let identities = DocumentIdentities::default();

        let error = match read_tracked_document(&identities, &path) {
            Err(error) => error,
            Ok(_) => panic!("a directory must not read as a document"),
        };
        fs::remove_dir_all(directory).unwrap();
        assert!(error.contains("not a regular file"), "{error}");
    }

    #[test]
    fn reading_a_file_past_the_size_limit_is_refused() {
        let directory = temporary_directory();
        let path = directory.join("huge.md");
        // Sparse: the length is metadata, so the test costs no disk.
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_DOCUMENT_BYTES + 1)
            .unwrap();
        let path = path.to_string_lossy().into_owned();
        let identities = DocumentIdentities::default();

        let error = match read_tracked_document(&identities, &path) {
            Err(error) => error,
            Ok(_) => panic!("an oversized file must not read as a document"),
        };
        fs::remove_dir_all(directory).unwrap();
        assert!(error.contains("larger than"), "{error}");
    }

    /// A path that cannot cross the IPC boundary as a string must be refused:
    /// the lossy conversion it replaced silently named a different file.
    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_is_refused() {
        use std::os::unix::ffi::OsStrExt;

        let invalid = std::ffi::OsStr::from_bytes(b"notes-\xff.md");
        assert!(invalid.to_string_lossy().contains('\u{FFFD}'));

        let error = chosen_path(FilePath::Path(invalid.into()))
            .expect_err("a non-UTF-8 path must be refused");
        assert!(error.contains("not valid UTF-8"), "{error}");
        assert_eq!(
            chosen_path(FilePath::Path("notes.md".into())).unwrap(),
            "notes.md"
        );
    }

    #[test]
    fn startup_document_loads_valid_file() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "# hello").unwrap();
        let argument = path.to_string_lossy().into_owned();

        let identities = DocumentIdentities::default();
        let result = startup_document_from_argument(&identities, Some(&argument));
        // A read alone must not become the baseline: only the frontend
        // adopting the version it put in the buffer does that.
        assert_eq!(document_status(&identities, &argument).status, "untracked");
        identities.adopt(&argument);
        assert_eq!(document_status(&identities, &argument).status, "unchanged");
        fs::write(&path, "external edit").unwrap();
        assert_eq!(
            save_to_path(&identities, &argument, "my edit", false).unwrap(),
            Some(ConflictKind::Changed)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
        fs::remove_dir_all(directory).unwrap();

        let document = match result {
            Ok(Some(document)) => document,
            Ok(None) => panic!("expected a document, got None"),
            Err(error) => panic!("expected a document, got error: {error}"),
        };
        assert_eq!(document.path.as_deref(), Some(argument.as_str()));
        assert_eq!(document.name, "notes.md");
        assert_eq!(document.content, "# hello");
    }

    #[test]
    fn startup_document_without_argument_is_none() {
        match startup_document_from_argument(&DocumentIdentities::default(), None) {
            Ok(None) => {}
            Ok(Some(_)) => panic!("expected no document without an argument"),
            Err(error) => panic!("expected no argument to succeed, got error: {error}"),
        }
    }

    #[test]
    fn startup_document_missing_file_errors() {
        let directory = temporary_directory();
        let path = directory.join("absent.md");
        let argument = path.to_string_lossy().into_owned();
        fs::remove_dir_all(directory).unwrap();

        let error = match startup_document_from_argument(
            &DocumentIdentities::default(),
            Some(&argument),
        ) {
            Err(error) => error,
            Ok(_) => panic!("expected a missing file to error"),
        };
        assert!(error.contains("Could not open"), "unexpected error: {error}");
        assert!(error.contains("absent.md"), "unexpected error: {error}");
    }

    #[test]
    fn startup_document_invalid_utf8_errors() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, [0xFF, 0xFE, 0x00]).unwrap();
        let argument = path.to_string_lossy().into_owned();
        let identities = DocumentIdentities::default();
        let result = startup_document_from_argument(&identities, Some(&argument));
        assert!(identities.expected(&argument).is_none());
        fs::remove_dir_all(directory).unwrap();

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("expected invalid UTF-8 to error"),
        };
        assert!(error.contains("Could not open"), "unexpected error: {error}");
        assert!(error.contains("notes.md"), "unexpected error: {error}");
        assert!(error.contains("UTF-8"), "unexpected error: {error}");
    }

    #[cfg(unix)]
    #[test]
    fn replacement_during_read_keeps_the_original_identity_and_blocks_save() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        let replacement = directory.join("replacement.md");
        fs::write(&path, "old writing").unwrap();
        fs::write(&replacement, "new external writing").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        let document = read_tracked_document_with(&identities, &key, |file| {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            fs::rename(&replacement, &path)?;
            Ok(content)
        })
        .unwrap();
        identities.adopt(&key);
        let status = document_status(&identities, &key).status;
        let save = save_to_path(&identities, &key, "my edit", false).unwrap();
        let disk = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(document.content, "old writing");
        assert_eq!(status, "changed");
        assert_eq!(save, Some(ConflictKind::Changed));
        assert_eq!(disk, "new external writing");
    }

    #[test]
    fn in_place_change_during_read_rejects_content_and_preserves_baseline() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "original").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        read_tracked_document(&identities, &key).unwrap();
        identities.adopt(&key);
        let baseline = identities.expected(&key).unwrap();

        let result = read_tracked_document_with(&identities, &key, |file| {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            fs::write(&path, "modified")?;
            // Same-sized writes must also be detected, without timing sleeps.
            let modified = baseline.modified.unwrap() + std::time::Duration::from_secs(1);
            fs::OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_modified(modified)?;
            Ok(content)
        });
        let expected = identities.expected(&key);
        let save = save_to_path(&identities, &key, "my edit", false).unwrap();
        let disk = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        let error = result.err().expect("an unstable read must fail");
        assert!(error.contains("File changed while being read"), "{error}");
        assert_eq!(expected, Some(baseline));
        assert_eq!(save, Some(ConflictKind::Changed));
        assert_eq!(disk, "modified");
    }

    #[cfg(unix)]
    #[test]
    fn removal_during_read_is_not_mistaken_for_an_untracked_file() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old writing").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        let document = read_tracked_document_with(&identities, &key, |file| {
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            fs::remove_file(&path)?;
            Ok(content)
        })
        .unwrap();
        identities.adopt(&key);
        let save = save_to_path(&identities, &key, "my edit", false).unwrap();
        let exists = path.exists();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(document.content, "old writing");
        assert_eq!(save, Some(ConflictKind::Removed));
        assert!(!exists);
    }

    #[test]
    fn saving_reports_no_conflict_while_the_file_is_untouched() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);

        let result = save_to_path(&identities, &key, "second", false);
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(result.unwrap(), None);
        assert_eq!(contents, "second");
    }

    #[test]
    fn saving_reports_a_conflict_when_the_file_changed_on_disk() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);

        fs::write(&path, "someone else's longer version").unwrap();
        let result = save_to_path(&identities, &key, "mine", false);
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(result.unwrap(), Some(ConflictKind::Changed));
        assert_eq!(contents, "someone else's longer version");
    }

    #[test]
    fn forcing_a_save_overwrites_and_refreshes_the_identity() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);

        fs::write(&path, "someone else's longer version").unwrap();
        let forced = save_to_path(&identities, &key, "mine", true);
        let next = save_to_path(&identities, &key, "mine again", false);
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(forced.unwrap(), None, "a forced save must write");
        assert_eq!(
            next.unwrap(),
            None,
            "the forced save must refresh the identity"
        );
        assert_eq!(contents, "mine again");
    }

    #[test]
    fn saving_reports_a_removed_file_and_recreates_it_when_forced() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);
        fs::remove_file(&path).unwrap();

        let result = save_to_path(&identities, &key, "recreated", false);
        let forced = save_to_path(&identities, &key, "recreated", true);
        let contents = fs::read_to_string(&path).ok();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(result.unwrap(), Some(ConflictKind::Removed));
        assert_eq!(forced.unwrap(), None);
        assert_eq!(contents.as_deref(), Some("recreated"));
    }

    #[test]
    fn saving_an_untracked_path_writes_without_a_conflict_check() {
        let directory = temporary_directory();
        let path = directory.join("fresh.md");
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        let result = save_to_path(&identities, &key, "hello", false);
        let contents = fs::read_to_string(&path).ok();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(result.unwrap(), None);
        assert_eq!(contents.as_deref(), Some("hello"));
    }

    #[test]
    fn document_status_reports_outside_edits() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        let untracked = document_status(&identities, &key).status;
        track(&identities, &key);
        let unchanged = document_status(&identities, &key).status;
        fs::write(&path, "second, longer").unwrap();
        let changed = document_status(&identities, &key).status;
        fs::remove_file(&path).unwrap();
        let removed = document_status(&identities, &key).status;
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(untracked, "untracked");
        assert_eq!(unchanged, "unchanged");
        assert_eq!(changed, "changed");
        assert_eq!(removed, "removed");
    }

    #[test]
    fn only_an_adopted_read_becomes_the_save_baseline() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        read_tracked_document(&identities, &key).unwrap();
        assert_eq!(document_status(&identities, &key).status, "untracked");
        // Adopting a path nobody read must not invent a baseline.
        identities.adopt(&directory.join("other.md").to_string_lossy());
        assert_eq!(document_status(&identities, &key).status, "untracked");

        identities.adopt(&key);
        assert_eq!(document_status(&identities, &key).status, "unchanged");
        // The staged version is consumed, not left to be adopted twice.
        fs::write(&path, "outside edit").unwrap();
        identities.adopt(&key);
        assert_eq!(document_status(&identities, &key).status, "changed");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_write_reports_the_identity_of_the_bytes_it_stored() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();

        let reported = atomic_write(&path, "new content").unwrap();
        let on_disk = FileIdentity::read(&path).unwrap();
        // The baseline a save records must describe the file it just wrote,
        // not whatever a later stat of the pathname happens to find.
        save_to_path(&identities, &key, "third content", false).unwrap();
        let baseline = identities.expected(&key).unwrap();
        let saved = FileIdentity::read(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(reported, on_disk, "the writer must report what it stored");
        assert_eq!(baseline, saved, "the baseline must describe the saved file");
    }

    #[cfg(unix)]
    #[test]
    fn a_durability_failure_still_records_the_written_identity() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "old content").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);

        // Write and execute but no read: the rename succeeds, opening the
        // directory for its durability sync does not.
        let mode = directory.metadata().unwrap().permissions().mode();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o300)).unwrap();
        let result = save_to_path(&identities, &key, "new content", false);
        fs::set_permissions(&directory, fs::Permissions::from_mode(mode)).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let baseline = identities.expected(&key);
        let saved = FileIdentity::read(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(contents, "new content", "the write still reached the file");
        // A privileged user can open a write-only directory, leaving no
        // durability failure to exercise.
        let Err(error) = result else {
            assert_eq!(baseline, Some(saved));
            return;
        };
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            baseline,
            Some(saved),
            "the baseline must describe the file the save left behind"
        );
    }

    #[test]
    fn an_absent_document_has_no_lock_to_take() {
        let directory = temporary_directory();
        let lock = lock_destination(&directory.join("absent.md"));
        fs::remove_dir_all(directory).unwrap();

        assert!(lock.is_none(), "a first save has no version to protect");
    }

    #[cfg(unix)]
    #[test]
    fn a_held_lock_is_refused_and_released_on_drop() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "content").unwrap();

        let held = lock_destination(&path).expect("an existing file can be locked");
        let second = fs::OpenOptions::new().read(true).open(&path).unwrap();
        let refused = second.try_lock().is_err();
        drop(held);
        let granted = second.try_lock().is_ok();
        fs::remove_dir_all(directory).unwrap();

        assert!(refused, "a second holder must not take the same lock");
        assert!(granted, "dropping the guard must release the lock");
    }

    #[cfg(unix)]
    #[test]
    fn a_save_waits_for_the_instance_that_holds_the_lock() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "content").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        track(&identities, &key);

        let held = lock_destination(&path).expect("the destination can be locked");
        let (done, finished) = std::sync::mpsc::channel();
        let saving = std::thread::spawn(move || {
            done.send(save_to_path(&identities, &key, "edit", false).is_ok())
                .unwrap();
        });

        let waited = finished
            .recv_timeout(std::time::Duration::from_millis(150))
            .is_err();
        drop(held);
        let saved = finished.recv_timeout(std::time::Duration::from_secs(5));
        saving.join().unwrap();
        let contents = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(directory).unwrap();

        assert!(waited, "a save must wait for the instance already writing");
        assert!(saved.unwrap(), "the waiting save must still succeed");
        assert_eq!(contents, "edit");
    }
}
