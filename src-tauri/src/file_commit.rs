//! Flush parent-directory metadata after file creation, replacement, or deletion.

use std::io;
use std::path::Path;

/// Flush the directory entry after a successful filesystem change.
#[cfg(unix)]
pub(crate) fn sync_directory(dir: &Path) -> io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(windows)]
pub(crate) fn sync_directory(dir: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;

    // Directory handles require backup semantics. FlushFileBuffers also needs
    // write access; a read-only handle opens successfully but cannot be flushed.
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dir)?
        .sync_all()
}
