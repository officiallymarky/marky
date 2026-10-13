//! The `marky-image` protocol, which lets the editor display images stored on
//! disk.
//!
//! A document can reference any path, so unlike the file commands this
//! protocol cannot limit itself to paths the app chose. It limits what it
//! serves instead: absolute paths to regular files whose extension names an
//! image type. A webview-script bug can therefore read pictures, never
//! documents, keys or configuration.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::http::{header, HeaderValue, Request, Response, StatusCode};

/// The URI scheme; the frontend passes the same name to `convertFileSrc`.
pub const SCHEME: &str = "marky-image";

/// Largest image served. Past this the request is refused instead of buffered.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// An SVG opened as a page rather than through `<img>` must not run script.
const IMAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'";

/// The content type of an image file, by case-insensitive extension. Files
/// with any other extension are not served.
fn content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn refused(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, reason)
}

/// Reads an image file. The path is checked before the file is opened:
/// opening a FIFO named `photo.png` would block the reading thread.
fn read_image(path: &Path) -> io::Result<(Vec<u8>, &'static str)> {
    if !path.is_absolute() {
        return Err(refused("image path is not absolute"));
    }
    let mime = content_type(path).ok_or_else(|| refused("not an image file"))?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(refused("not a regular file"));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(refused("image is too large"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_IMAGE_BYTES)
        .read_to_end(&mut bytes)?;
    Ok((bytes, mime))
}

/// Answers one protocol request, whose URI path is the percent-encoded file
/// path `convertFileSrc` produced.
pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let encoded = request.uri().path().trim_start_matches('/');
    let image = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| refused("image path is not valid UTF-8"))
        .and_then(|path| read_image(Path::new(path.as_ref())));
    match image {
        Ok((bytes, mime)) => {
            let mut response = Response::new(bytes);
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            headers.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(IMAGE_CSP),
            );
            response
        }
        Err(error) => {
            let mut response = Response::new(Vec::new());
            *response.status_mut() = if error.kind() == io::ErrorKind::NotFound {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::FORBIDDEN
            };
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{content_type, respond, IMAGE_CSP, SCHEME};
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::http::{header, Request, Response, StatusCode};

    fn temporary_directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "marky-image-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// Requests `path` the way `convertFileSrc` encodes it.
    fn request(path: &str) -> Response<Vec<u8>> {
        let encoded = utf8_percent_encode(path, NON_ALPHANUMERIC);
        respond(
            &Request::builder()
                .uri(format!("{SCHEME}://localhost/{encoded}"))
                .body(Vec::new())
                .unwrap(),
        )
    }

    fn get(path: &Path) -> Response<Vec<u8>> {
        request(path.to_str().unwrap())
    }

    #[test]
    fn image_types_are_recognized_whatever_the_extension_case() {
        assert_eq!(content_type(Path::new("/a/photo.JPG")), Some("image/jpeg"));
        assert_eq!(content_type(Path::new("/a/photo.jpeg")), Some("image/jpeg"));
        assert_eq!(
            content_type(Path::new("/a/diagram.Svg")),
            Some("image/svg+xml")
        );
        assert_eq!(content_type(Path::new("/a/notes.md")), None);
        assert_eq!(content_type(Path::new("/a/png")), None);
    }

    #[test]
    fn an_image_is_served_with_its_type_and_no_script_policy() {
        let directory = temporary_directory();
        let path = directory.join("my picture #1.PNG");
        fs::write(&path, b"png bytes").unwrap();

        let response = get(&path);
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), b"png bytes");
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "image/png");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], IMAGE_CSP);
    }

    /// The protocol must not become a way to read documents or other files.
    #[test]
    fn a_file_that_is_not_an_image_is_refused() {
        let directory = temporary_directory();
        let path = directory.join("notes.md");
        fs::write(&path, "private writing").unwrap();

        let response = get(&path);
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
    }

    #[test]
    fn a_directory_named_like_an_image_is_refused() {
        let directory = temporary_directory();
        let path = directory.join("album.png");
        fs::create_dir(&path).unwrap();

        let response = get(&path);
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_missing_image_is_not_found() {
        let directory = temporary_directory();
        let response = get(&directory.join("absent.png"));
        fs::remove_dir_all(directory).unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /// A relative path would resolve against the app's working directory.
    #[test]
    fn a_relative_path_is_refused() {
        assert_eq!(request("images/photo.png").status(), StatusCode::FORBIDDEN);
    }
}
