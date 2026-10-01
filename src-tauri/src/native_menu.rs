use serde::Deserialize;

/// RGB values come from the active CSS palette; numeric values cannot inject CSS.
#[derive(Deserialize)]
pub struct MenuPalette {
    bg: u32,
    fg: u32,
    muted: u32,
    border: u32,
    accent: u32,
    hover: u32,
}

#[cfg(target_os = "linux")]
thread_local! {
    static PROVIDER: std::cell::RefCell<Option<gtk::CssProvider>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "linux")]
fn install(window: &gtk::ApplicationWindow, provider: &gtk::CssProvider) -> Result<(), String> {
    use gtk::prelude::*;

    // Submenus are separate popup windows, so tag them explicitly rather than
    // relying on a selector rooted at the application's window.
    fn tag(widget: &gtk::Widget) {
        if widget.is::<gtk::MenuBar>() {
            widget.style_context().add_class("marky-menubar");
        } else if widget.is::<gtk::Menu>() {
            widget.style_context().add_class("marky-menu");
        }
        if let Some(item) = widget.downcast_ref::<gtk::MenuItem>() {
            if let Some(submenu) = item.submenu() {
                tag(&submenu);
            }
        }
        if let Some(container) = widget.downcast_ref::<gtk::Container>() {
            for child in container.children() {
                tag(&child);
            }
        }
    }

    tag(window.upcast_ref());
    let screen = gtk::prelude::WidgetExt::screen(window).ok_or("native menu screen is missing")?;
    gtk::StyleContext::add_provider_for_screen(
        &screen,
        provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    Ok(())
}

#[tauri::command]
pub fn set_menu_palette(app: tauri::AppHandle, palette: MenuPalette) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use tauri::Manager;

        let css = format!(
            "@define-color marky_bg #{:06x};\n\
             @define-color marky_fg #{:06x};\n\
             @define-color marky_muted #{:06x};\n\
             @define-color marky_border #{:06x};\n\
             @define-color marky_accent #{:06x};\n\
             @define-color marky_hover #{:06x};\n{}",
            palette.bg,
            palette.fg,
            palette.muted,
            palette.border,
            palette.accent,
            palette.hover,
            include_str!("native-menu.css"),
        );
        PROVIDER.with(|state| {
            let mut state = state.borrow_mut();
            if let Some(provider) = state.as_ref() {
                return provider
                    .load_from_data(css.as_bytes())
                    .map_err(|error| format!("cannot style native menus: {error}"));
            }
            let provider = gtk::CssProvider::new();
            provider
                .load_from_data(css.as_bytes())
                .map_err(|error| format!("cannot style native menus: {error}"))?;
            let window = app
                .get_webview_window("main")
                .ok_or("main window is missing")?
                .gtk_window()
                .map_err(|error| error.to_string())?;
            install(&window, &provider)?;
            *state = Some(provider);
            Ok(())
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        // Other platforms retain their OS-native menu appearance.
        let _ = (app, palette);
        Ok(())
    }
}
