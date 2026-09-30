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
  GitHub-style alerts, and footnote references and definitions.
- **Source editing** — switch between the rich editor and raw Markdown, including
  the document's front matter.
- **Focus mode and themes** — dim surrounding blocks while writing and choose a
  light or dark theme. The initial theme follows your system preference.
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
status. It preserves unrelated YAML and leaves unsupported multiline values
untouched. A supported single-line `title` value becomes the window title;
otherwise, marky uses the file name.

### File protection

marky checks for outside changes before overwriting a file. If another program
has changed or removed it, you can resolve the conflict rather than silently
replacing the on-disk version. When an unchanged document is updated externally,
marky reloads it the next time the window gains focus. Documents with unsaved
edits prompt before reloading.

Closing a document with unsaved changes offers **Save**, **Close without saving**,
or **Keep editing**. Read-only files are rejected on save. Atomic replacement is
used where file metadata can be preserved; files that require in-place writes,
such as hard-linked files, retain that behavior.

## Usage

Open marky from your application launcher, or pass a document path on the command
line:

```sh
marky notes.md
```

The **File**, **Edit**, **Insert**, and **View** menus provide document actions,
search, content insertion, and display settings. The floating toolbar provides
formatting and insertion controls without leaving the editor.

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
| `F9` | Toggle light and dark themes |

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
- Search matches cannot span formatting boundaries, such as plain text followed
  by bold text.
- Spelling and grammar checking applies only to the rich editor, not source mode
  or the front-matter panel. Code is excluded, stylistic suggestions are hidden,
  and documents longer than 400,000 characters are not checked.

See the [roadmap](ROADMAP.md) for planned improvements.
