use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
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
use tauri_plugin_dialog::DialogExt;

const APP_TITLE: &str = "marky";
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
        let inode = 0_u64;
        format!("{}:{modified}:{inode}", self.length)
    }
}

/// On-disk fingerprints of the documents this window has read, so a save can
/// tell whether another program changed or removed the file in the meantime.
#[derive(Default, Clone)]
struct DocumentIdentities {
    entries: Arc<Mutex<HashMap<String, FileIdentity>>>,
}

impl DocumentIdentities {
    fn record(&self, path: &str) {
        let Ok(identity) = FileIdentity::read(Path::new(path)) else {
            return;
        };
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(path.to_string(), identity);
        }
    }

    fn expected(&self, path: &str) -> Option<FileIdentity> {
        let entries = self.entries.lock().ok()?;
        entries.get(path).cloned()
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

fn read_document(path: &str) -> Result<Document, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Could not open {}: {e}", file_name_of(path)))?;
    Ok(Document {
        path: Some(path.to_string()),
        name: file_name_of(path),
        content,
    })
}

/// Reads a document and remembers the version it came from.
fn read_tracked_document(identities: &DocumentIdentities, path: &str) -> Result<Document, String> {
    let document = read_document(path)?;
    identities.record(path);
    Ok(document)
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

/// Writes `content` unless the file changed on disk since it was read, in
/// which case nothing is written and the conflict is returned for the UI.
fn save_to_path(
    identities: &DocumentIdentities,
    path: &str,
    content: &str,
    force: bool,
) -> io::Result<Option<ConflictKind>> {
    if let Some(conflict) = save_conflict(identities, path, force) {
        return Ok(Some(conflict));
    }
    atomic_write(Path::new(path), content)?;
    identities.record(path);
    Ok(None)
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

fn startup_document_from_argument(argument: Option<&str>) -> Result<Option<Document>, String> {
    match argument {
        None => Ok(None),
        Some(path) => read_document(path).map(Some),
    }
}

/// Document passed on the command line (`marky notes.md`), if any.
#[tauri::command]
fn startup_document(
    state: tauri::State<'_, DocumentIdentities>,
) -> Result<Option<Document>, String> {
    let document = startup_document_from_argument(std::env::args().nth(1).as_deref())?;
    if let Some(path) = document
        .as_ref()
        .and_then(|document| document.path.as_deref())
    {
        state.record(path);
    }
    Ok(document)
}

#[tauri::command]
async fn open_document(
    app: AppHandle,
    state: tauri::State<'_, DocumentIdentities>,
) -> Result<Option<Document>, String> {
    let identities = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("All files", &["*"])
            .blocking_pick_file();
        match picked {
            Some(file) => read_tracked_document(&identities, &file.to_string()).map(Some),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("Open failed: {e}"))?
}

/// Re-reads a known path, used when adopting a file that changed on disk.
#[tauri::command]
fn load_document(
    state: tauri::State<'_, DocumentIdentities>,
    path: String,
) -> Result<Document, String> {
    read_tracked_document(&state, &path)
}

/// Reports whether the file still matches the version the app read.
#[tauri::command]
fn check_document(state: tauri::State<'_, DocumentIdentities>, path: String) -> DocumentStatus {
    document_status(&state, &path)
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

fn write_in_place(path: &Path, content: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
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

fn atomic_write(path: &Path, content: &str) -> io::Result<()> {
    let write_path = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => canonicalize_for_write(path)?,
        Ok(_) => path.to_path_buf(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
        Err(error) => return Err(error),
    };
    let parent = write_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if write_path.file_name().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "save path has no file name",
        ));
    }
    let metadata = match fs::metadata(&write_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };

    if metadata
        .as_ref()
        .is_some_and(|metadata| metadata.permissions().readonly())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "cannot overwrite a read-only file",
        ));
    }

    #[cfg(unix)]
    if metadata
        .as_ref()
        .is_some_and(|metadata| metadata.nlink() > 1)
    {
        return write_in_place(&write_path, content);
    }

    #[cfg(not(unix))]
    if metadata.is_some() {
        // The standard library cannot copy platform ACLs and extended metadata.
        return write_in_place(&write_path, content);
    }

    #[cfg(unix)]
    let attributes = match metadata.as_ref() {
        Some(_) => match read_extended_attributes(&write_path) {
            Ok(attributes) => Some(attributes),
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
            Err(error) => return Err(error),
        };

        #[cfg(unix)]
        if let Some(existing_metadata) = &metadata {
            let temporary_metadata = match file.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    drop(file);
                    let _ = fs::remove_file(&temp_path);
                    return Err(error);
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
            return Err(error);
        }

        #[cfg(unix)]
        if let Some(attributes) = &attributes {
            if write_extended_attributes(&temp_path, attributes).is_err() {
                drop(file);
                let _ = fs::remove_file(&temp_path);
                return write_in_place(&write_path, content);
            }
        }

        if let Some(metadata) = &metadata {
            if file.set_permissions(metadata.permissions()).is_err() {
                drop(file);
                let _ = fs::remove_file(&temp_path);
                return write_in_place(&write_path, content);
            }
        }
        let sync_result = file.sync_all();
        drop(file);

        let result = sync_result.and_then(|()| fs::rename(&temp_path, &write_path));
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        return result;
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not reserve a temporary save file",
    ))
}

#[tauri::command]
async fn save_document(
    app: AppHandle,
    state: tauri::State<'_, DocumentIdentities>,
    path: Option<String>,
    content: String,
    force: bool,
) -> Result<SaveOutcome, String> {
    // No known path: raise the save dialog (Save As).
    let target = match path {
        Some(p) => Some(p),
        None => tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("Markdown", &["md", "markdown"])
                .set_file_name("Untitled.md")
                .blocking_save_file()
        })
        .await
        .map_err(|e| format!("Save failed: {e}"))?
        .map(|file| file.to_string()),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NVIDIA Wayland: webkit2gtk crashes or renders a dead webview
    // (Gdk protocol error / GBM buffer failure) without this workaround,
    // matching the dev recipe in the justfile. Must be set before the
    // web context is created, so it is set at process start.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    tauri::Builder::default()
        .manage(DocumentIdentities::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            startup_document,
            open_document,
            load_document,
            check_document,
            save_document,
            set_window_title
        ])
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().as_ref());
        })
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::*;

                let window = app.get_webview_window("main").ok_or("main window is missing")?;
                let gtk_window = window.gtk_window()?;
                // Tao's Wayland header has its own title, separate from the window.
                if let Some(header) = gtk_window
                    .titlebar()
                    .and_then(|bar| bar.downcast::<gtk::Bin>().ok())
                    .and_then(|bar| bar.child())
                    .and_then(|child| child.downcast::<gtk::HeaderBar>().ok())
                {
                    gtk_window
                        .bind_property("title", &header, "title")
                        .sync_create()
                        .build();
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

            let new_item = MenuItemBuilder::with_id("new", "New").build(app)?;
            let open_item = MenuItemBuilder::with_id("open", "Open…").build(app)?;
            let save_item = MenuItemBuilder::with_id("save", "Save").build(app)?;
            let save_as_item = MenuItemBuilder::with_id("save-as", "Save As…").build(app)?;
            let close_item = MenuItemBuilder::with_id("close", "Close Window").build(app)?;
            let front_matter_item =
                MenuItemBuilder::with_id("front-matter", "Front Matter…").build(app)?;

            let file = SubmenuBuilder::new(app, "File")
                .item(&new_item)
                .item(&open_item)
                .item(&save_item)
                .item(&save_as_item)
                .item(&front_matter_item)
                .separator()
                .item(&close_item)
                .build()?;

            let undo_item = MenuItemBuilder::with_id("undo", "Undo").build(app)?;
            let redo_item = MenuItemBuilder::with_id("redo", "Redo").build(app)?;
            let find_item =
                MenuItemBuilder::with_id("find", "Find/Replace (Ctrl+F)").build(app)?;
            let cut_item = MenuItemBuilder::with_id("cut", "Cut").build(app)?;
            let copy_item = MenuItemBuilder::with_id("copy", "Copy").build(app)?;
            let paste_item = MenuItemBuilder::with_id("paste", "Paste").build(app)?;
            let select_all_item =
                MenuItemBuilder::with_id("select-all", "Select All").build(app)?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .item(&undo_item)
                .item(&redo_item)
                .separator()
                .item(&find_item)
                .item(&cut_item)
                .item(&copy_item)
                .item(&paste_item)
                .item(&select_all_item)
                .build()?;

            let focus_item =
                MenuItemBuilder::with_id("focus", "Focus Mode (F8)").build(app)?;
            let theme_item =
                MenuItemBuilder::with_id("theme", "Dark Theme (F9)").build(app)?;
            let raw_item =
                MenuItemBuilder::with_id("raw", "Raw Mode (Ctrl+/)").build(app)?;
            let spell_item =
                MenuItemBuilder::with_id("spell", "Spell & Grammar Check (F7)").build(app)?;
            let view = SubmenuBuilder::new(app, "View")
                .item(&focus_item)
                .item(&theme_item)
                .separator()
                .item(&raw_item)
                .item(&spell_item)
                .build()?;

            let table_item =
                MenuItemBuilder::with_id("insert-table", "Table…").build(app)?;
            let hr_item = MenuItemBuilder::with_id("insert-hr", "Horizontal Line")
                .build(app)?;
            let code_block_item =
                MenuItemBuilder::with_id("insert-code-block", "Code Block").build(app)?;
            let footnote_item =
                MenuItemBuilder::with_id("insert-footnote", "Footnote").build(app)?;
            let alert_note_item =
                MenuItemBuilder::with_id("insert-alert-note", "Note").build(app)?;
            let alert_tip_item =
                MenuItemBuilder::with_id("insert-alert-tip", "Tip").build(app)?;
            let alert_important_item =
                MenuItemBuilder::with_id("insert-alert-important", "Important").build(app)?;
            let alert_warning_item =
                MenuItemBuilder::with_id("insert-alert-warning", "Warning").build(app)?;
            let alert_caution_item =
                MenuItemBuilder::with_id("insert-alert-caution", "Caution").build(app)?;
            let alert = SubmenuBuilder::new(app, "Alert")
                .item(&alert_note_item)
                .item(&alert_tip_item)
                .item(&alert_important_item)
                .item(&alert_warning_item)
                .item(&alert_caution_item)
                .build()?;
            let insert = SubmenuBuilder::new(app, "Insert")
                .item(&table_item)
                .item(&hr_item)
                .item(&code_block_item)
                .item(&alert)
                .item(&footnote_item)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&file, &edit, &insert, &view])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, document_status, save_to_path, startup_document_from_argument, ConflictKind,
        DocumentIdentities,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("marky-atomic-save-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        path
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
            result.unwrap_err().kind(),
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
        fs::remove_dir_all(directory).unwrap();

        result.unwrap();
        assert_eq!(alias_contents, "new content");
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

    #[test]
    fn startup_document_loads_valid_file() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "# hello").unwrap();
        let argument = path.to_string_lossy().into_owned();

        let result = startup_document_from_argument(Some(&argument));
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
        match startup_document_from_argument(None) {
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

        let error = match startup_document_from_argument(Some(&argument)) {
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
        let result = startup_document_from_argument(Some(&argument));
        fs::remove_dir_all(directory).unwrap();

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("expected invalid UTF-8 to error"),
        };
        assert!(error.contains("Could not open"), "unexpected error: {error}");
        assert!(error.contains("notes.md"), "unexpected error: {error}");
        assert!(error.contains("UTF-8"), "unexpected error: {error}");
    }

    #[test]
    fn saving_reports_no_conflict_while_the_file_is_untouched() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "first").unwrap();
        let identities = DocumentIdentities::default();
        let key = path.to_string_lossy().into_owned();
        identities.record(&key);

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
        identities.record(&key);

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
        identities.record(&key);

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
        identities.record(&key);
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
        identities.record(&key);
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
}
