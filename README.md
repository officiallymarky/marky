# marky

A Markdown editor for Linux, built for writing and editing local documents in a
single, focused workspace. marky renders formatting directly in the editor, so
there is no separate preview pane to manage. Switch to Markdown source whenever
you need direct control over the file.

Built with [Tauri 2](https://tauri.app),
[Milkdown](https://milkdown.dev), and ProseMirror.

## Features

### Writing and formatting

- **Rich Markdown editing** — headings, emphasis, strikethrough, links, images,
  blockquotes, and ordered, unordered, and task lists.
- **Floating toolbar** — formatting controls and insert actions available while
  the editor is focused, with clickable checkboxes for task lists.
- **Structured content** — insert tables, horizontal rules, fenced code blocks,
  GitHub-style alerts, footnotes, and live tables of contents.
- **Source editing** — switch between the rich editor and raw Markdown, including
  the document's front matter.
- **Focus mode and themes** — dim surrounding blocks while writing and pick a
  theme: Light, Sepia, Solarized Light, Dark, Nord, Dracula, Catppuccin, or
  Tokyo Night.
- **Writing font** — pick the rich editor's font family (System Sans, Serif,
  or Monospace) and size (Small/Medium/Large). Raw mode keeps its fixed
  monospace source view. Theme and font choices persist and live in the
  Appearance menu (themes also cycle with F9).
- **Document status** — word and character counts, the current file path, and an
  unsaved-change indicator.

### Code and diagrams

Fenced code blocks support syntax highlighting for common programming languages,
markup, and configuration formats. Pressing `Tab` inside a code block inserts
two spaces without moving focus out of the editor.

Code blocks tagged `mermaid` render live diagrams beneath their editable source,
with error hints for invalid syntax. See the
[Mermaid showcase](examples/mermaid-showcase.md) for examples.

### Search and proofreading

Find and replace includes live match highlighting, a match counter,
previous/next navigation, and case-sensitive search. It works in both the rich
editor and source mode. In the rich editor, Replace All is a single undoable
operation; source-mode replacements use the text area's native undo history.

[Harper](https://writewithharper.com) provides on-device spelling and grammar
checking. Select an underlined issue to review suggestions, ignore it, or add a
word to your dictionary. Dictionary entries and ignored issues persist across
sessions. Checking runs locally in a background worker without sending document
text to an external service.

### YAML front matter

Documents with YAML front matter display it in an editable panel above the
body. Front matter is kept separate from rich-text serialization, preserving its
contents when you edit the document body.

The **Front Matter** dialog creates or updates a title, date, tags, aliases, and
status. It preserves unrelated YAML and refuses unsupported multiline values or
list syntax rather than rewriting them unsafely; use the front-matter panel or
source mode for those edits. A supported single-line `title` value becomes the
window title; otherwise, marky uses the file name.

### File protection

marky checks for outside changes before overwriting a file. If another program
has changed or removed it, you can resolve the conflict rather than silently
replacing the on-disk version. When an unchanged document is updated externally,
marky reloads it the next time the window gains focus. Documents with unsaved
edits prompt before reloading.
If you edit the document, reopen it, or switch editing modes while a reload is
pending, marky abandons that reload rather than replacing your current buffer.

The content and version fingerprint come from the same open file, with a
stability check around the read. A replacement remains detectable as an outside
change; a file modified in place during reading is rejected rather than accepted
as a trustworthy baseline.

Closing a document with unsaved changes offers **Save**, **Close without saving**,
or **Keep editing**. Read-only files are rejected on save. Atomic replacement is
used where file metadata can be preserved; files that require in-place writes,
such as hard-linked files, retain that behavior.

### Crash recovery

marky automatically backs up unsaved writing to private recovery files in the
application data directory's `recovery/` folder. Snapshots include untitled
documents, rich-editor and source-mode edits, and front matter. They do **not**
save over the original Markdown file.

Snapshots are scheduled after a 500 ms pause in editing, or within a two-second
window during continuous typing. Writes use atomic replacement and filesystem
syncs. Each document session has its own snapshot; running instances cannot
claim or discard one another's active backups.

On startup, snapshots left by a stopped instance offer **Restore**, **Discard**,
or **Later**. Restore opens the recovered source in raw mode as an **unsaved
copy**, leaving the original file untouched even if it changed on disk. Use Save
or Save As to choose where to keep the recovered writing. Later retains the
backup for a future startup; after restoring one document, any other available
backups remain deferred.

A successful save clears the backup when no edits remain unsaved. Edits made
while a save is running remain eligible for recovery. Explicitly discarding a
document also removes its backup; cancelling a close keeps it.

## Usage

Open marky from your application launcher, or pass a document path on the command
line:

```sh
marky notes.md
```

The **File**, **Edit**, **Insert**, **View**, and **Appearance** menus provide
document actions, search, content insertion, display settings, and theme and
font choices. On Linux, the menu bar and its dropdowns follow the selected editor
theme, with thin-bordered dropdowns and no added shadow or glow. The floating
toolbar provides formatting and insertion controls without leaving the editor.

### Table of contents

Choose **Insert → Table of Contents** in the menu bar or floating toolbar, or
write `[TOC]` or `[[TOC]]` in a top-level paragraph of its own (separate it from
other prose with blank lines). Both markers render a nested outline of the document's
headings and update as headings change. Click an entry, or focus it and press
Enter, to jump to that heading.

Saved Markdown keeps the original marker rather than a generated list. Markers
inside code blocks, inline code, lists, blockquotes, or prose stay literal; use
`\[TOC]` to display a standalone marker without generating an outline.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` | New document |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save |
| `Ctrl+M` | Create or edit front matter |
| `Ctrl+F` | Open find and replace |
| `Ctrl+H` | Open find and replace with replacement controls visible |
| `Enter` / `Shift+Enter` | Next / previous match while searching |
| `Ctrl+/` | Toggle Markdown source mode |
| `Tab` | Insert two spaces in a code block, indent a list item, or move to the next table cell |
| `F7` | Toggle spelling and grammar checking |
| `F8` | Toggle focus mode |
| `F9` | Cycle themes (Appearance menu picks a specific one) |

## Development

### Requirements

- Node.js and pnpm
- Rust and Cargo
- [just](https://just.systems)
- The Linux system dependencies listed in the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

Install the frontend dependencies and start the development application:

```sh
pnpm install
just dev
```

### Build and verification

```sh
pnpm build      # Build the frontend; run before verification on a fresh checkout
just verify     # Run tests, Oxlint, TypeScript checks, Clippy, and Cargo checks
just build      # Build the release application and deb, rpm, and AppImage bundles
```

Release bundles are written to `src-tauri/target/release/bundle/`. The standalone
release binary is at `src-tauri/target/release/marky`.

`just scan` runs dependency and secret checks separately and requires
`osv-scanner` and `gitleaks`. Use `just --list` to see all available recipes.

### Project structure

| Path | Responsibility |
| --- | --- |
| `src/` | TypeScript editor, toolbar, search, proofreading, and document workflows |
| `src-tauri/` | Rust application shell, native menus and dialogs, and file access |
| `src/recovery.ts` | Debounced recovery snapshots, serialized writes, and save/discard cleanup |
| `src-tauri/src/recovery.rs` | Private, atomic snapshot storage and multi-instance recovery locks |
| `tests/` | Frontend behavioral tests |
| `examples/` | Sample Markdown documents |
| `ROADMAP.md` | Planned work and implementation status |

### Linux runtime notes

marky sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` at startup to avoid WebKitGTK
rendering failures on NVIDIA Wayland. No manual environment setting is needed
for the packaged application.

The WebKit inspector is disabled in both development and release builds. For a
debugging session, set `devtools` to `true` in `src-tauri/tauri.conf.json` and
rebuild. The debug binary requires the development frontend server on port 1420;
`just dev` starts both together.

## Current limitations

- Image paste and upload, PDF/HTML/DOCX export, and mathematical notation are not
  implemented.
- Recovery is periodic, not a per-keystroke guarantee: a crash before the next
  completed snapshot can still lose the most recent edits. Private recovery files
  are not encrypted.
- Search matches cannot span formatting boundaries, such as plain text followed
  by bold text.
- Spelling and grammar checking applies only to the rich editor, not source mode
  or the front-matter panel. Code is excluded, stylistic suggestions are hidden,
  and documents longer than 400,000 characters are not checked.

See the [roadmap](ROADMAP.md) for planned improvements.
