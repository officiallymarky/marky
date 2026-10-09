//! Last-closed-window geometry, independent of documents and recovery snapshots.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{LogicalSize, PhysicalPosition, WebviewWindow, WindowEvent};

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Geometry {
    width: f64,
    height: f64,
    position: Option<PhysicalPosition<i32>>,
    maximized: bool,
}

impl Geometry {
    fn load(path: &Path) -> io::Result<Option<Self>> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let geometry: Self = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if !geometry.width.is_finite()
            || !geometry.height.is_finite()
            || geometry.width <= 0.0
            || geometry.height <= 0.0
            || geometry.width > 65_535.0
            || geometry.height > 65_535.0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid window size",
            ));
        }
        Ok(Some(geometry))
    }

    fn save(&self, path: &Path) -> io::Result<()> {
        let content = serde_json::to_string(self).map_err(io::Error::other)?;
        super::atomic_write(path, &content)
            .map(|_| ())
            .map_err(super::WriteFailure::into_io)
    }

    fn capture(window: &WebviewWindow) -> tauri::Result<Self> {
        #[cfg(target_os = "linux")]
        let size = {
            use gtk::prelude::GtkWindowExt;
            // Match GTK's resize units; Tao's Wayland inner_size includes the
            // client-side titlebar and shadows, causing growth on each reopen.
            let (width, height) = window.gtk_window()?.size();
            LogicalSize::new(f64::from(width), f64::from(height))
        };
        #[cfg(not(target_os = "linux"))]
        let size = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?);
        Ok(Self {
            width: size.width,
            height: size.height,
            position: window.outer_position().ok(),
            maximized: window.is_maximized()?,
        })
    }

    fn update(&mut self, window: &WebviewWindow) -> tauri::Result<()> {
        // Minimizing/fullscreen must not replace the normal restore geometry.
        if window.is_minimized()? || window.is_fullscreen()? {
            return Ok(());
        }
        self.maximized = window.is_maximized()?;
        if !self.maximized {
            let current = Self::capture(window)?;
            if current.width > 0.0 && current.height > 0.0 {
                self.width = current.width;
                self.height = current.height;
                self.position = current.position;
            }
        }
        Ok(())
    }

    fn restore(&mut self, window: &WebviewWindow) -> tauri::Result<()> {
        let monitors = window.available_monitors()?;
        let monitor = self.position.and_then(|position| {
            monitors.iter().find(|monitor| {
                let area = monitor.work_area();
                contains(
                    area.position.x,
                    area.position.y,
                    area.size.width,
                    area.size.height,
                    position,
                )
            })
        });
        if let Some(monitor) = monitor {
            let area = monitor.work_area();
            let scale = monitor.scale_factor();
            self.width = self.width.min(f64::from(area.size.width) / scale);
            self.height = self.height.min(f64::from(area.size.height) / scale);
            if let Some(position) = &mut self.position {
                // Keep the window reachable even if the monitor's usable area shrank.
                position.x = position.x.min(
                    area.position.x
                        + (f64::from(area.size.width) - self.width * scale).max(0.0) as i32,
                );
                position.y = position.y.min(
                    area.position.y
                        + (f64::from(area.size.height) - self.height * scale).max(0.0) as i32,
                );
            }
        } else {
            // A disconnected monitor must not leave the restored window off-screen.
            self.position = None;
            if let Some(monitor) = window
                .primary_monitor()?
                .or_else(|| monitors.first().cloned())
            {
                let area = monitor.work_area();
                self.width = self
                    .width
                    .min(f64::from(area.size.width) / monitor.scale_factor());
                self.height = self
                    .height
                    .min(f64::from(area.size.height) / monitor.scale_factor());
            }
        }
        window.set_size(LogicalSize::new(self.width, self.height))?;
        if let Some(position) = self.position {
            // Wayland compositors may ignore application-requested positions.
            window.set_position(position)?;
        } else {
            window.center()?;
        }
        if self.maximized {
            window.maximize()?;
        }
        Ok(())
    }
}

fn contains(x: i32, y: i32, width: u32, height: u32, position: PhysicalPosition<i32>) -> bool {
    i64::from(position.x) >= i64::from(x)
        && i64::from(position.y) >= i64::from(y)
        && i64::from(position.x) < i64::from(x) + i64::from(width)
        && i64::from(position.y) < i64::from(y) + i64::from(height)
}

pub(crate) fn install(window: &WebviewWindow, path: std::path::PathBuf) -> tauri::Result<()> {
    let mut geometry = Geometry::capture(window)?;
    match Geometry::load(&path) {
        Ok(Some(mut saved)) => match saved.restore(window) {
            Ok(()) => geometry = saved,
            Err(error) => eprintln!("cannot restore window geometry: {error}"),
        },
        Ok(None) => {}
        Err(error) => eprintln!("cannot read window geometry: {error}"),
    }
    let geometry = Mutex::new(geometry);
    let tracked = window.clone();
    window.on_window_event(move |event| {
        let Ok(mut geometry) = geometry.lock() else {
            return;
        };
        match event {
            WindowEvent::Destroyed => {
                // CloseRequested can be cancelled by the unsaved-document prompt.
                if let Err(error) = geometry.save(&path) {
                    eprintln!("cannot save window geometry: {error}");
                }
            }
            WindowEvent::Resized(_)
            | WindowEvent::Moved(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Focused(_)
            | WindowEvent::CloseRequested { .. } => {
                if let Err(error) = geometry.update(&tracked) {
                    eprintln!("cannot capture window geometry: {error}");
                }
            }
            _ => {}
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_bounds_allow_negative_coordinates_and_do_not_overflow() {
        assert!(contains(
            -1920,
            0,
            1920,
            1080,
            PhysicalPosition::new(-1200, 100)
        ));
        assert!(!contains(
            -1920,
            0,
            1920,
            1080,
            PhysicalPosition::new(0, 100)
        ));
        assert!(!contains(0, 0, 1920, 1080, PhysicalPosition::new(100, -1)));
        assert!(contains(
            i32::MAX - 100,
            0,
            200,
            100,
            PhysicalPosition::new(i32::MAX, 50)
        ));
    }

    #[test]
    fn geometry_survives_restart_and_rejects_invalid_sizes() {
        let root = std::env::temp_dir().join(format!("marky-window-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("window.json");
        let geometry = Geometry {
            width: 820.0,
            height: 610.0,
            position: Some(PhysicalPosition::new(-1200, 80)),
            maximized: true,
        };
        geometry.save(&path).unwrap();
        let restored = Geometry::load(&path).unwrap().unwrap();
        assert_eq!((restored.width, restored.height), (820.0, 610.0));
        assert_eq!(restored.position, geometry.position);
        assert!(restored.maximized);
        for width in [0, -1, 100_000] {
            fs::write(
                &path,
                format!(r#"{{"width":{width},"height":610,"position":null,"maximized":false}}"#),
            )
            .unwrap();
            assert!(Geometry::load(&path).is_err());
        }
        fs::write(&path, "broken JSON").unwrap();
        assert!(Geometry::load(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
