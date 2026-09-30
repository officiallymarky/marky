//! Private crash-recovery snapshots stored under the application data
//! directory. Every snapshot is a `<uuid>.json` file guarded by an OS advisory
//! lock on a `<uuid>.lock` sidecar that the owning instance keeps for the
//! whole active session, so any process can tell live snapshots apart from
//! orphans left behind by a crash. The lock lives on the sidecar, not on the
//! snapshot inode: the sidecar is created once and never rewritten, while the
//! content file itself is replaced atomically through a temp file, `sync`,
//! `rename`, and a parent directory sync, so a failed write always leaves the
//! previous snapshot intact and nothing outside this directory is ever
//! touched.
//!
//! Sidecar files are only removed or created while the caller holds the
//! stable directory-wide `.store.lock` guard (never removed itself), so an
//! instance can never lock a sidecar inode that another instance is about to
//! unlink and recreate.

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const SNAPSHOT_SUFFIX: &str = ".json";
const LOCK_SUFFIX: &str = ".lock";
const TEMP_PREFIX: &str = ".recovery-tmp-";
const GUARD_NAME: &str = ".store.lock";


static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

/// A snapshot as the frontend asks the backend to persist it. The backend
/// assigns `updatedAt` when it writes the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryWrite {
    pub(crate) id: String,
    pub(crate) path: Option<String>,
    pub(crate) name: String,
    pub(crate) content: String,
}

/// A snapshot as stored on disk and returned by listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySnapshot {
    pub(crate) id: String,
    pub(crate) path: Option<String>,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) updated_at: u64,
}

/// Listing result: orphan snapshots that can be restored, plus one message
/// per snapshot that could not be read, so a single corrupt journal never
/// hides the recoverable ones. Error messages identify the id and file but
/// never quote snapshot content.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryListing {
    pub(crate) snapshots: Vec<RecoverySnapshot>,
    pub(crate) errors: Vec<String>,
}

/// A borrowed view of a snapshot for serialization: the record the frontend
/// handed over plus the backend-assigned `updatedAt`, without copying the
/// document content.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSnapshot<'a> {
    #[serde(flatten)]
    snapshot: &'a RecoveryWrite,
    updated_at: u64,
}

/// A stable directory-wide advisory lock held transiently across the whole
/// filesystem-plus-sidecar phase of write, list, and discard, so no instance
/// can remove or recreate a sidecar while another one is between opening it
/// and locking it. The guard file is created once and never removed.
struct DirectoryGuard<'a>(&'a File);

impl DirectoryGuard<'_> {
    fn acquire(file: &File) -> io::Result<DirectoryGuard<'_>> {
        file.lock()
            .map_err(|e| io::Error::other(format!("recovery store guard cannot be locked: {e}")))?;
        Ok(DirectoryGuard(file))
    }
}

impl Drop for DirectoryGuard<'_> {
    fn drop(&mut self) {
        unlock_quietly(self.0);
    }
}

/// Recovery snapshots for one instance. Clones share the same lock table, so
/// the per-snapshot advisory locks are held exactly once per process.
#[derive(Clone, Debug)]
pub(crate) struct RecoveryStore {
    root: Arc<PathBuf>,
    guard: Arc<File>,
    locks: Arc<Mutex<HashMap<String, File>>>,
}

impl RecoveryStore {
    /// Opens (creating if needed) the private recovery directory `directory`
    /// and its stable guard file.
    pub(crate) fn new(directory: PathBuf) -> io::Result<Self> {
        create_recovery_root(&directory)?;
        #[cfg(unix)]
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join(GUARD_NAME))?;
        #[cfg(not(unix))]
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(GUARD_NAME))?;
        Ok(Self {
            root: Arc::new(directory),
            guard: Arc::new(guard),
            locks: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Writes or replaces the snapshot for `snapshot.id`, taking the per-id
    /// advisory lock for this session if it is not held yet. A failed write
    /// preserves the previous snapshot and keeps the lock. The directory
    /// guard is held throughout, so no other instance can remove or recreate
    /// the sidecar mid-operation.
    pub(crate) fn write(&self, snapshot: &RecoveryWrite) -> io::Result<()> {
        let id = snapshot_id(&snapshot.id)?;
        let mut locks = self.locks.lock().expect("recovery lock table");
        let _guard = DirectoryGuard::acquire(&self.guard)?;
        self.ensure_locked(&mut locks, id)?;
        let record = StoredSnapshot {
            snapshot,
            updated_at: now_millis(),
        };
        let serialized = serde_json::to_vec(&record)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        atomic_replace(&self.snapshot_path(id), &serialized)
    }

    /// Returns the orphan snapshots (left by crashed instances) and claims
    /// each one by holding its advisory lock, so no other instance can
    /// restore or rewrite it concurrently. Snapshots that are live in a
    /// running instance — this one included — are skipped silently. Corrupt
    /// snapshots are reported in `errors`, left untouched, and released, so
    /// they stay inspectable without blocking valid recoveries. The whole
    /// listing runs under the directory guard, and a guard failure is
    /// reported as a listing error.
    pub(crate) fn list(&self) -> RecoveryListing {
        let mut listing = RecoveryListing::default();
        let mut locks = self.locks.lock().expect("recovery lock table");
        let _guard = match DirectoryGuard::acquire(&self.guard) {
            Ok(guard) => guard,
            Err(e) => {
                listing.errors.push(format!(
                    "recovery directory {} cannot be locked for listing: {e}",
                    self.root.display()
                ));
                return listing;
            }
        };
        let mut candidates = Vec::new();
        match fs::read_dir(self.root.as_path()) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else {
                        listing
                            .errors
                            .push("a recovery directory entry cannot be read".to_string());
                        continue;
                    };
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else {
                        continue;
                    };
                    let Some(id) = name.strip_suffix(SNAPSHOT_SUFFIX) else {
                        continue;
                    };
                    if !is_canonical_uuid(id) {
                        continue; // not one of ours; leave it alone
                    }
                    candidates.push((id.to_string(), entry.path()));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return listing,
            Err(e) => {
                listing.errors.push(format!(
                    "recovery directory {} cannot be listed: {e}",
                    self.root.display()
                ));
                return listing;
            }
        }
        candidates.sort();
        for (id, json_path) in candidates {
            let lock_path = self.lock_path(&id);
            match claim_orphan(&mut locks, &id, &json_path, &lock_path) {
                Ok(Some(snapshot)) => listing.snapshots.push(snapshot),
                Ok(None) => {}
                Err(message) => listing.errors.push(message),
            }
        }
        listing
            .snapshots
            .sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.id.cmp(&a.id)));
        listing
    }

    /// Deletes exactly the snapshot with this id. A snapshot locked by
    /// another running instance is refused; an absent id is an idempotent
    /// no-op that creates nothing. This instance's lock entry survives a
    /// failing removal while the sidecar pathname still exists and is
    /// dropped once the sidecar is gone, so the entry can never refer to an
    /// unlinked inode. Runs under the directory guard.
    pub(crate) fn discard(&self, id: &str) -> io::Result<()> {
        let id = snapshot_id(id)?;
        let json_path = self.snapshot_path(id);
        let lock_path = self.lock_path(id);
        let mut locks = self.locks.lock().expect("recovery lock table");
        let _guard = DirectoryGuard::acquire(&self.guard)?;
        if locks.contains_key(id) {
            let removed = remove_snapshot(&self.root, &json_path, &lock_path);
            // Keep the live claim only while the sidecar pathname exists; a
            // sidecar unlinked by this call (even when a later fsync failed)
            // leaves a stale inode that must not stay in the table.
            if fs::symlink_metadata(&lock_path)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
            {
                locks.remove(id); // dropping the fd releases the advisory lock
            }
            return removed;
        }
        if let Some(message) = planted_link(&lock_path) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, message));
        }
        let file = match OpenOptions::new().read(true).write(true).open(&lock_path) {
            Ok(file) => file,
            // Without a lock file no instance can hold this id, so there is
            // nothing live to protect: remove the snapshot if it is there.
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return match fs::remove_file(&json_path) {
                    Ok(()) => sync_directory(&self.root),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e),
                };
            }
            Err(e) => return Err(e),
        };
        match file.try_lock() {
            Err(TryLockError::WouldBlock) => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "recovery snapshot {id} is active in another instance and cannot be discarded"
                ),
            )),
            Err(TryLockError::Error(e)) => Err(e),
            Ok(()) => {
                let removed = remove_snapshot(&self.root, &json_path, &lock_path);
                drop(file);
                removed
            }
        }
    }

    /// Drops this instance's claim on a snapshot without deleting it, so a
    /// deferred startup prompt leaves the snapshot for a later session. The
    /// id stays writable: a later write simply locks it again.
    pub(crate) fn release(&self, id: &str) -> io::Result<()> {
        let id = snapshot_id(id)?;
        let mut locks = self.locks.lock().expect("recovery lock table");
        if let Some(file) = locks.remove(id) {
            unlock_quietly(&file);
        }
        Ok(())
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}{SNAPSHOT_SUFFIX}"))
    }

    fn lock_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}{LOCK_SUFFIX}"))
    }

    /// Holds the advisory lock for `id` on its sidecar, acquiring it if this
    /// session does not hold it yet.
    fn ensure_locked(&self, locks: &mut HashMap<String, File>, id: &str) -> io::Result<()> {
        if locks.contains_key(id) {
            return Ok(());
        }
        let lock_path = self.lock_path(id);
        if let Some(message) = planted_link(&lock_path) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, message));
        }
        #[cfg(unix)]
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)?;
        #[cfg(not(unix))]
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        match file.try_lock() {
            Ok(()) => {
                locks.insert(id.to_string(), file);
                Ok(())
            }
            Err(TryLockError::WouldBlock) => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("recovery snapshot {id} is active in another instance"),
            )),
            Err(TryLockError::Error(e)) => Err(e),
        }
    }
}

/// Takes the advisory lock on an orphan snapshot's sidecar and reads its
/// content. Returns `Ok(None)` when the snapshot is live in another instance,
/// and an error message (without content) when it cannot be read; in the
/// error case the lock is released and both files are left untouched.
fn claim_orphan(
    locks: &mut HashMap<String, File>,
    id: &str,
    json_path: &Path,
    lock_path: &Path,
) -> Result<Option<RecoverySnapshot>, String> {
    if locks.contains_key(id) {
        return Ok(None); // this session already holds it as a live snapshot
    }
    if let Some(message) = planted_link(lock_path) {
        return Err(message);
    }
    #[cfg(unix)]
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_path);
    #[cfg(not(unix))]
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path);
    let file = file.map_err(|e| {
        format!(
            "recovery snapshot {id} at {} cannot be locked: {e}",
            lock_path.display()
        )
    })?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(None), // live elsewhere
        Err(TryLockError::Error(e)) => {
            return Err(format!(
                "recovery snapshot {id} at {} cannot be locked: {e}",
                lock_path.display()
            ))
        }
    }
    if let Some(message) = planted_link(json_path) {
        unlock_quietly(&file);
        return Err(message);
    }
    match read_snapshot(id, json_path) {
        Ok(snapshot) => {
            locks.insert(id.to_string(), file);
            Ok(Some(snapshot))
        }
        Err(message) => {
            unlock_quietly(&file);
            Err(message)
        }
    }
}

/// Reads and validates one snapshot file, rejecting records whose id does
/// not match the file name.
fn read_snapshot(expected_id: &str, path: &Path) -> Result<RecoverySnapshot, String> {
    let serialized = fs::read_to_string(path)
        .map_err(|e| format!("recovery snapshot {expected_id} at {} cannot be read: {e}", path.display()))?;
    let snapshot: RecoverySnapshot = serde_json::from_str(&serialized).map_err(|e| {
        format!("recovery snapshot {expected_id} at {} is corrupt: {e}", path.display())
    })?;
    if snapshot.id != expected_id {
        return Err(format!(
            "recovery snapshot {} at {} records id {} inside the file",
            expected_id,
            path.display(),
            snapshot.id
        ));
    }
    Ok(snapshot)
}

/// Reports a non-regular file (symlink, directory, …) planted at a snapshot
/// path, or `None` when the path is absent or a regular file.
fn planted_link(path: &Path) -> Option<String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            Some(format!("{} is not a regular snapshot file", path.display()))
        }
        Ok(_) => None,
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => Some(format!("{} cannot be inspected: {e}", path.display())),
    }
}

/// Removes a snapshot and its sidecar durably: the recovery directory is
/// synced after the JSON removal (before the sidecar is unlinked) and again
/// after the sidecar removal, so a crash cannot resurrect either file.
/// Absent files count as already removed.
fn remove_snapshot(root: &Path, json_path: &Path, lock_path: &Path) -> io::Result<()> {
    remove_file_durably(root, json_path)?;
    match fs::remove_file(lock_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    sync_directory(root)
}

fn remove_file_durably(root: &Path, path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    sync_directory(root)
}

/// Only exact canonical lowercase 36-character UUIDs are accepted as
/// snapshot ids; anything else could not map safely onto a file name anyway.
fn is_canonical_uuid(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
    })
}

fn snapshot_id(id: &str) -> Result<&str, io::Error> {
    if is_canonical_uuid(id) {
        Ok(id)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("recovery id {id:?} is not a canonical 36-character UUID"),
        ))
    }
}

/// Creates the recovery directory with private permissions.
fn create_recovery_root(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    if let Some(parent) = root.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

/// Replaces `path` atomically: write to a unique temp file, sync it, rename
/// it over the target, then sync the directory so the rename itself is
/// durable. A failure anywhere before the rename leaves the target untouched.
fn atomic_replace(path: &Path, payload: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "snapshot path has no parent directory")
    })?;
    let temp = parent.join(format!(
        "{TEMP_PREFIX}{}-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        now_millis()
    ));
    let written = (|| -> io::Result<()> {
        #[cfg(unix)]
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        #[cfg(not(unix))]
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(payload)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    sync_directory(parent)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn unlock_quietly(file: &File) {
    let _ = file.unlock();
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        is_canonical_uuid, now_millis, RecoveryListing, RecoverySnapshot, RecoveryStore,
        RecoveryWrite, LOCK_SUFFIX, SNAPSHOT_SUFFIX,
    };
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    /// A temporary directory that removes itself, so failed assertions never
    /// leak state into the temp directory.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nonce = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("marky-recovery-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn snapshot_path(&self, id: &str) -> PathBuf {
            self.path().join(format!("{id}{SNAPSHOT_SUFFIX}"))
        }

        fn lock_path(&self, id: &str) -> PathBuf {
            self.path().join(format!("{id}{LOCK_SUFFIX}"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store_for(dir: &TempDir) -> RecoveryStore {
        RecoveryStore::new(dir.path().to_path_buf()).unwrap()
    }

    fn uuid(n: u64) -> String {
        format!("{n:08x}-0000-0000-0000-{n:012x}")
    }

    fn write_of(id: &str, content: &str) -> RecoveryWrite {
        RecoveryWrite {
            id: id.to_string(),
            path: Some(format!("/notes/{id}.md")),
            name: format!("note {id}"),
            content: content.to_string(),
        }
    }

    fn open_locked_probe(path: &Path) -> File {
        let file = File::open(path).unwrap();
        file.try_lock().expect("expected no held lock here");
        file
    }

    fn read_stored_content(path: &Path) -> String {
        let raw = fs::read_to_string(path).unwrap();
        let snapshot: RecoverySnapshot = serde_json::from_str(&raw).unwrap();
        snapshot.content
    }

    #[test]
    fn write_then_list_returns_snapshots_newest_first() {
        let dir = TempDir::new();
        let writer = store_for(&dir);
        for (number, content, updated_at) in [
            (1, "middle", 20),
            (2, "newest", 30),
            (3, "oldest", 10),
        ] {
            let id = uuid(number);
            writer.write(&write_of(&id, content)).unwrap();
            let path = dir.snapshot_path(&id);
            let mut stored: RecoverySnapshot =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            stored.updated_at = updated_at;
            fs::write(path, serde_json::to_vec(&stored).unwrap()).unwrap();
        }
        drop(writer); // like a crashed instance, releasing its locks

        let reader = store_for(&dir);
        let listing: RecoveryListing = reader.list();
        let ids: Vec<String> = listing.snapshots.iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids, vec![uuid(2), uuid(1), uuid(3)]);
        assert!(
            listing
                .snapshots
                .windows(2)
                .all(|w| w[0].updated_at >= w[1].updated_at)
        );
        assert_eq!(listing.snapshots[0].content, "newest");
        assert_eq!(listing.snapshots[0].name, format!("note {}", uuid(2)));
        assert_eq!(
            listing.snapshots[0].path,
            Some(format!("/notes/{}.md", uuid(2)))
        );
        assert!(listing.errors.is_empty());
    }

    #[test]
    fn rewriting_same_id_replaces_one_snapshot() {
        let dir = TempDir::new();
        let writer = store_for(&dir);
        writer.write(&write_of(&uuid(1), "first")).unwrap();
        writer.write(&write_of(&uuid(1), "second")).unwrap();
        drop(writer);

        let reader = store_for(&dir);
        let listing = reader.list();
        assert_eq!(listing.snapshots.len(), 1);
        assert_eq!(listing.snapshots[0].content, "second");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3); // json + lock + guard
        assert_eq!(read_stored_content(&dir.snapshot_path(&uuid(1))), "second");
    }

    #[cfg(unix)]
    #[test]
    fn failed_write_preserves_previous_snapshot() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let store = store_for(&dir);
        store.write(&write_of(&uuid(1), "old content")).unwrap();

        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let result = store.write(&write_of(&uuid(1), "new content"));
        let preserved = read_stored_content(&dir.snapshot_path(&uuid(1)));
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();

        assert!(result.is_err());
        assert_eq!(preserved, "old content");
        // No temp leftovers from the failed write.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }

    #[test]
    fn cleared_id_rewritten_is_not_claimable_by_other_instances() {
        let dir = TempDir::new();
        let owner = store_for(&dir);
        owner.write(&write_of(&uuid(1), "cleared")).unwrap();
        // A bystander that opened the old sidecar before the clear must never
        // turn that stale inode into a claim over the rewritten snapshot.
        let stale = File::open(dir.lock_path(&uuid(1))).unwrap();
        owner.discard(&uuid(1)).unwrap();
        owner.write(&write_of(&uuid(1), "rewritten after clear")).unwrap();

        let bystander = store_for(&dir);
        let listing = bystander.list();
        assert!(listing.snapshots.is_empty());
        assert!(listing.errors.is_empty());
        drop(stale);
        assert_eq!(
            read_stored_content(&dir.snapshot_path(&uuid(1))),
            "rewritten after clear"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_discard_keeps_live_ownership() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let owner = store_for(&dir);
        let bystander = store_for(&dir);
        owner.write(&write_of(&uuid(1), "kept")).unwrap();

        // Deny inspection as well as removal: a stat failure is not absence.
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o000)).unwrap();
        let failed = owner.discard(&uuid(1));
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let during = bystander.list();

        assert!(failed.is_err());
        // The failed removal must not have released this instance's claim.
        assert!(during.snapshots.is_empty());
        assert!(dir.snapshot_path(&uuid(1)).exists());
        assert!(dir.lock_path(&uuid(1)).exists());

        owner.discard(&uuid(1)).unwrap();
        assert!(!dir.snapshot_path(&uuid(1)).exists());
        assert!(!dir.lock_path(&uuid(1)).exists());
        assert!(bystander.list().snapshots.is_empty());
    }

    #[test]
    fn corrupt_snapshots_are_reported_without_deletion_or_locks() {
        let dir = TempDir::new();
        let writer = store_for(&dir);
        writer.write(&write_of(&uuid(1), "valid")).unwrap();
        drop(writer);
        // Not JSON at all.
        fs::write(dir.snapshot_path(&uuid(2)), "not json at all").unwrap();
        // Valid JSON whose recorded id does not match the file name.
        let mismatched = serde_json::to_vec(&RecoverySnapshot {
            id: uuid(4),
            path: None,
            name: "mismatched".to_string(),
            content: "".to_string(),
            updated_at: now_millis(),
        })
        .unwrap();
        fs::write(dir.snapshot_path(&uuid(3)), mismatched).unwrap();

        let reader = store_for(&dir);
        let listing = reader.list();

        assert_eq!(listing.snapshots.len(), 1);
        assert_eq!(listing.snapshots[0].id, uuid(1));
        assert_eq!(listing.snapshots[0].content, "valid");
        assert_eq!(listing.errors.len(), 2);
        assert!(
            listing
                .errors
                .iter()
                .all(|e| e.contains("recovery snapshot"))
        );
        assert!(listing.errors.iter().any(|e| e.contains(&uuid(2))));
        assert!(listing.errors.iter().any(|e| e.contains(&uuid(3))));
        // Corrupt files are left exactly as they were and stay unlocked.
        assert_eq!(
            fs::read_to_string(dir.snapshot_path(&uuid(2))).unwrap(),
            "not json at all"
        );
        for id in [uuid(2), uuid(3)] {
            drop(open_locked_probe(&dir.lock_path(&id)));
        }
    }

    #[test]
    fn live_snapshot_is_hidden_from_other_instances_and_cannot_be_discarded() {
        let dir = TempDir::new();
        let owner = store_for(&dir);
        let other = store_for(&dir);
        owner.write(&write_of(&uuid(1), "live")).unwrap();

        let listing = other.list();
        assert!(listing.snapshots.is_empty());
        assert!(listing.errors.is_empty());

        let discard = other.discard(&uuid(1));
        assert!(discard.is_err());
        assert!(dir.snapshot_path(&uuid(1)).exists());

        // Even the owning instance does not relist its own live snapshot.
        let own_listing = owner.list();
        assert!(own_listing.snapshots.is_empty());
        assert!(own_listing.errors.is_empty());
    }

    #[test]
    fn orphan_is_claimed_exclusively_by_the_first_listing() {
        let dir = TempDir::new();
        let crashed = store_for(&dir);
        crashed.write(&write_of(&uuid(1), "orphan")).unwrap();
        crashed.release(&uuid(1)).unwrap(); // simulates the crash

        let first = store_for(&dir);
        let listing = first.list();
        assert_eq!(listing.snapshots.len(), 1);
        assert_eq!(listing.snapshots[0].content, "orphan");

        let second = store_for(&dir);
        assert!(second.list().snapshots.is_empty());

        first.release(&uuid(1)).unwrap();
        let re_listed = second.list();
        assert_eq!(re_listed.snapshots.len(), 1);
        assert_eq!(re_listed.snapshots[0].id, uuid(1));
    }

    #[test]
    fn released_id_can_be_written_again_and_stays_locked() {
        let dir = TempDir::new();
        let crashed = store_for(&dir);
        crashed.write(&write_of(&uuid(1), "orphan")).unwrap();
        crashed.release(&uuid(1)).unwrap();

        let resumed = store_for(&dir);
        assert_eq!(resumed.list().snapshots[0].id, uuid(1));
        resumed.release(&uuid(1)).unwrap();
        resumed
            .write(&write_of(&uuid(1), "restored and edited"))
            .unwrap();
        assert_eq!(
            read_stored_content(&dir.snapshot_path(&uuid(1))),
            "restored and edited"
        );

        let bystander = store_for(&dir);
        assert!(bystander.list().snapshots.is_empty());
    }

    #[test]
    fn claimed_snapshot_can_be_discarded_by_the_claiming_store() {
        let dir = TempDir::new();
        let crashed = store_for(&dir);
        crashed.write(&write_of(&uuid(1), "orphan")).unwrap();
        crashed.release(&uuid(1)).unwrap();

        let claiming = store_for(&dir);
        assert_eq!(claiming.list().snapshots.len(), 1);
        claiming.discard(&uuid(1)).unwrap();

        assert!(!dir.snapshot_path(&uuid(1)).exists());
        assert!(!dir.lock_path(&uuid(1)).exists());
        assert!(claiming.list().snapshots.is_empty());
    }

    #[test]
    fn discard_removes_only_the_requested_id() {
        let dir = TempDir::new();
        let store = store_for(&dir);
        store.write(&write_of(&uuid(1), "doomed")).unwrap();
        store.write(&write_of(&uuid(2), "survivor")).unwrap();

        store.discard(&uuid(1)).unwrap();

        assert!(!dir.snapshot_path(&uuid(1)).exists());
        assert!(!dir.lock_path(&uuid(1)).exists());
        assert!(dir.snapshot_path(&uuid(2)).exists());
        drop(store);
        let reader = store_for(&dir);
        let listing = reader.list();
        assert_eq!(listing.snapshots.len(), 1);
        assert_eq!(listing.snapshots[0].id, uuid(2));
    }

    #[test]
    fn absent_ids_discard_and_release_as_idempotent_no_ops() {
        let dir = TempDir::new();
        let store = store_for(&dir);
        store.discard(&uuid(1)).unwrap();
        store.release(&uuid(1)).unwrap();

        // Only the stable guard file exists; the no-op created nothing.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        // Still writable afterwards with the same id.
        store.write(&write_of(&uuid(1), "late writer")).unwrap();
        assert_eq!(
            read_stored_content(&dir.snapshot_path(&uuid(1))),
            "late writer"
        );
    }

    #[test]
    fn non_canonical_ids_are_rejected_everywhere() {
        let dir = TempDir::new();
        let store = store_for(&dir);
        for bad in [
            "not-a-uuid".to_string(),
            uuid(1).replace('-', ""),
            format!("{}/../evil", uuid(1)),
            format!("{}extra", uuid(1)),
        ] {
            let write = store.write(&write_of(&bad, "content"));
            let discard = store.discard(&bad);
            let release = store.release(&bad);
            assert!(write.is_err(), "write accepted {bad:?}");
            assert!(discard.is_err(), "discard accepted {bad:?}");
            assert!(release.is_err(), "release accepted {bad:?}");
            let message = write.unwrap_err().to_string();
            assert!(message.contains("canonical"), "message was {message:?}");
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1); // guard only
    }

    #[test]
    fn canonical_uuid_check_matches_the_exact_shape() {
        assert!(is_canonical_uuid(&uuid(0xab)));
        assert!(!is_canonical_uuid(&uuid(0xab).to_uppercase()));
        assert!(!is_canonical_uuid(&uuid(0xab)[..35]));
        assert!(!is_canonical_uuid(&uuid(7)[..35]));
        assert!(!is_canonical_uuid("00000007-0000-0000-0000-00000000000z"));
        assert!(!is_canonical_uuid(""));
    }

    #[test]
    fn listing_ignores_files_that_are_not_canonical_snapshot_names() {
        let dir = TempDir::new();
        let writer = store_for(&dir);
        writer.write(&write_of(&uuid(1), "real")).unwrap();
        drop(writer);
        fs::write(dir.path().join("unrelated.txt"), "keep me").unwrap();

        let reader = store_for(&dir);
        let listing = reader.list();

        assert_eq!(listing.snapshots.len(), 1);
        assert!(listing.errors.is_empty());
        assert!(dir.path().join("unrelated.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn recovery_storage_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let store = store_for(&dir);
        store.write(&write_of(&uuid(1), "secret-ish draft")).unwrap();

        let dir_mode = fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(dir.snapshot_path(&uuid(1)))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let lock_mode = fs::metadata(dir.lock_path(&uuid(1)))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        assert_eq!(lock_mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_symlink_is_replaced_without_touching_the_target() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        let store = store_for(&dir);
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, dir.snapshot_path(&uuid(1))).unwrap();

        // The atomic rename replaces the link with a regular snapshot file;
        // the outside target is never read or written.
        store.write(&write_of(&uuid(1), "replaces the link")).unwrap();
        let outside_now = fs::read_to_string(&outside).unwrap();
        let restored = read_stored_content(&dir.snapshot_path(&uuid(1)));

        store.discard(&uuid(1)).unwrap();
        let outside_after_discard = fs::read_to_string(&outside).unwrap();

        assert_eq!(outside_now, "outside");
        assert_eq!(outside_after_discard, "outside");
        assert_eq!(restored, "replaces the link");
        assert!(!dir.snapshot_path(&uuid(1)).exists());
    }

    #[cfg(unix)]
    #[test]
    fn planted_lock_symlinks_are_refused_without_touching_the_target() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new();
        let store = store_for(&dir);
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, dir.lock_path(&uuid(1))).unwrap();

        let write = store.write(&write_of(&uuid(1), "clobber attempt"));
        let discard = store.discard(&uuid(1));
        let outside_now = fs::read_to_string(&outside).unwrap();
        let still_symlink = fs::symlink_metadata(dir.lock_path(&uuid(1)))
            .unwrap()
            .file_type()
            .is_symlink();

        assert!(write.is_err());
        assert!(discard.is_err());
        assert_eq!(outside_now, "outside");
        assert!(still_symlink);
        // The refused operations left no snapshot or temp files behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }
}
