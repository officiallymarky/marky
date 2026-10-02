use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

const LIMIT: usize = 10;

enum Access<'a> {
    Read,
    Remember(&'a str),
    Clear,
}

pub(crate) struct RecentStore {
    root: PathBuf,
    guard: Mutex<File>,
}

impl RecentStore {
    pub(crate) fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let guard = options.open(root.join(".guard"))?;
        Ok(Self {
            root,
            guard: Mutex::new(guard),
        })
    }

    pub(crate) fn paths(&self) -> io::Result<Vec<String>> {
        self.access(Access::Read)
    }

    pub(crate) fn remember(&self, path: &Path) -> io::Result<Vec<String>> {
        let path = fs::canonicalize(path)?;
        let path = path.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "recent path is not UTF-8")
        })?;
        self.access(Access::Remember(path))
    }

    pub(crate) fn clear(&self) -> io::Result<Vec<String>> {
        self.access(Access::Clear)
    }

    // The stable guard protects read-modify-write across both threads and instances.
    fn access(&self, change: Access<'_>) -> io::Result<Vec<String>> {
        let guard = self
            .guard
            .lock()
            .map_err(|_| io::Error::other("recent files lock poisoned"))?;
        guard.lock().map_err(io::Error::other)?;
        let result = (|| {
            let target = self.root.join("list.json");
            let mut paths: Vec<String> = match fs::read(&target) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(error),
            };
            if paths.len() > LIMIT || paths.iter().any(|path| !Path::new(path).is_absolute()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid recent files list",
                ));
            }
            match change {
                Access::Read => return Ok(paths),
                Access::Clear => paths.clear(),
                Access::Remember(path) => {
                    if paths.first().is_some_and(|first| first == path) {
                        return Ok(paths);
                    }
                    paths.retain(|entry| entry != path);
                    paths.insert(0, path.to_owned());
                    paths.truncate(LIMIT);
                }
            }
            let content = serde_json::to_string(&paths).map_err(io::Error::other)?;
            super::atomic_write(&target, &content)?;
            File::open(&self.root)?.sync_all()?;
            Ok(paths)
        })();
        let unlocked = guard.unlock();
        result.and_then(|paths| unlocked.map(|()| paths))
    }
}

pub(crate) struct RecentDocuments {
    pub(crate) store: RecentStore,
    pub(crate) menu: Submenu<tauri::Wry>,
}

impl RecentDocuments {
    fn refresh(&self, app: &AppHandle, paths: &[String]) -> Result<(), String> {
        // Paths are embedded in IDs rather than indexes: queued clicks keep their target.
        let mut items = Vec::with_capacity(paths.len().max(1));
        for path in paths {
            items.push(
                MenuItemBuilder::with_id(format!("recent:{path}"), path.replace('&', "&&"))
                    .build(app)
                    .map_err(|error| error.to_string())?,
            );
        }
        if paths.is_empty() {
            items.push(
                MenuItemBuilder::with_id("recent-empty", "No recent files")
                    .enabled(false)
                    .build(app)
                    .map_err(|error| error.to_string())?,
            );
        }
        let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
        let clear = MenuItemBuilder::with_id("recent-clear", "Clear Recent Files")
            .enabled(!paths.is_empty())
            .build(app)
            .map_err(|error| error.to_string())?;
        for item in self.menu.items().map_err(|error| error.to_string())? {
            self.menu.remove(&item).map_err(|error| error.to_string())?;
        }
        for item in &items {
            self.menu.append(item).map_err(|error| error.to_string())?;
        }
        self.menu
            .append(&separator)
            .map_err(|error| error.to_string())?;
        self.menu.append(&clear).map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) fn refresh_recent_documents(app: AppHandle) -> Result<(), String> {
    let recent = app.state::<RecentDocuments>();
    let paths = recent.store.paths().map_err(|error| error.to_string())?;
    recent.refresh(&app, &paths)
}

#[tauri::command]
pub(crate) fn remember_document(app: AppHandle, path: String) -> Result<(), String> {
    let recent = app.state::<RecentDocuments>();
    let paths = recent
        .store
        .remember(Path::new(&path))
        .map_err(|error| error.to_string())?;
    recent.refresh(&app, &paths)
}

#[tauri::command]
pub(crate) fn clear_recent_documents(app: AppHandle) -> Result<(), String> {
    let recent = app.state::<RecentDocuments>();
    let paths = recent.store.clear().map_err(|error| error.to_string())?;
    recent.refresh(&app, &paths)
}

#[cfg(test)]
mod tests {
    use super::RecentStore;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "marky-recent-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn store(&self) -> RecentStore {
            RecentStore::new(self.0.join("recent")).unwrap()
        }

        fn document(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, "# notes").unwrap();
            fs::canonicalize(path).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn recent_files_survive_restart_and_reopening_promotes_without_duplicates() {
        let fixture = Fixture::new();
        let first = fixture.document("first.md");
        let second = fixture.document("second.md");
        let store = fixture.store();
        store.remember(&first).unwrap();
        store.remember(&second).unwrap();
        drop(store);
        let restarted = fixture.store();
        assert_eq!(
            restarted.paths().unwrap(),
            vec![second.to_str().unwrap(), first.to_str().unwrap()]
        );
        restarted.remember(&first).unwrap();
        assert_eq!(
            restarted.paths().unwrap(),
            vec![first.to_str().unwrap(), second.to_str().unwrap()]
        );
    }

    #[test]
    fn recent_files_evict_the_oldest_and_missing_opens_do_not_change_history() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let documents: Vec<_> = (0..12)
            .map(|index| fixture.document(&format!("{index}.md")))
            .collect();
        for path in &documents {
            store.remember(path).unwrap();
        }
        let expected: Vec<_> = documents[2..]
            .iter()
            .rev()
            .map(|path| path.to_str().unwrap())
            .collect();
        assert_eq!(store.paths().unwrap(), expected);
        assert!(store.remember(&fixture.0.join("missing.md")).is_err());
        assert_eq!(fixture.store().paths().unwrap(), expected);
    }

    #[test]
    fn separate_instances_merge_history_and_clearing_does_not_delete_documents() {
        let fixture = Fixture::new();
        let first = fixture.document("first.md");
        let second = fixture.document("second.md");
        let one = fixture.store();
        let two = fixture.store();
        one.remember(&first).unwrap();
        two.remember(&second).unwrap();
        assert_eq!(
            one.paths().unwrap(),
            vec![second.to_str().unwrap(), first.to_str().unwrap()]
        );
        two.clear().unwrap();
        assert_eq!(one.paths().unwrap(), Vec::<String>::new());
        assert_eq!(fs::read_to_string(first).unwrap(), "# notes");
        assert_eq!(fs::read_to_string(second).unwrap(), "# notes");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_relative_components_do_not_duplicate_a_document() {
        let fixture = Fixture::new();
        let path = fixture.document("notes.md");
        let alias = fixture.0.join("alias.md");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let store = fixture.store();
        store.remember(&path).unwrap();
        store.remember(&alias).unwrap();
        store
            .remember(&fixture.0.join(".").join("notes.md"))
            .unwrap();
        assert_eq!(store.paths().unwrap(), vec![path.to_str().unwrap()]);
    }
}
