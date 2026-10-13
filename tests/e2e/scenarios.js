/**
 * The scripted checks themselves. Each scenario drives the app the way the
 * native shell does and asserts rendered state plus the IPC the app sent.
 *
 * Scenarios are independent: each opens the document it needs, because the
 * document a previous scenario left behind is not a valid starting point (a
 * New leaves an untitled buffer, which the focus check skips entirely).
 */
const NOTES = {
  path: "/tmp/notes.md",
  name: "notes.md",
  content: "# Title\n\nHello world\n",
};

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rendered state: a `hidden` attribute or a class can lie about visibility. */
const visible = (element) => {
  if (!element) return false;
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
};

const editor = () => document.querySelector("#editor .ProseMirror");
const text = (element) => element?.textContent ?? "";
const lastTitle = (harness) => harness.state.window.titles.at(-1);

const menu = async (harness, action) => {
  harness.emit("menu-action", action);
  await settle();
};

/** Opens a document through the real Open flow (the dialog is Rust-side). */
const open = async (harness, document = NOTES) => {
  harness.pick(document);
  await menu(harness, "open");
  await settle(200);
};

/** Waits until `value()` stops changing: Milkdown mounts asynchronously. */
const settledValue = async (value, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  let last = value();
  let stable = 0;
  while (Date.now() < deadline && stable < 3) {
    await settle(50);
    const current = value();
    stable = current === last ? stable + 1 : 0;
    last = current;
  }
  return last;
};

const keydown = async (init) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  await settle();
};

/** Edits the buffer from raw mode, then returns to the rich editor. */
const editSource = async (harness, suffix) => {
  await menu(harness, "raw");
  const raw = document.querySelector("#raw-editor");
  raw.value = `${raw.value}${suffix}`;
  raw.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  await menu(harness, "raw");
};

export async function runScenarios(harness) {
  const scenarios = [];
  const record = async (name, body) => {
    const checks = [];
    const expect = (label, ok, detail) =>
      checks.push({ label, ok: Boolean(ok), detail: ok ? undefined : detail });
    let error = null;
    try {
      await body(expect);
    } catch (caught) {
      error = String(caught?.stack ?? caught);
    }
    scenarios.push({
      name,
      checks,
      error,
      ok: !error && checks.every((check) => check.ok),
    });
  };

  await record("recovered writing opens as an unsaved source copy", async (expect) => {
    expect(
      "the restore fetched the text the listing left out",
      harness.calls("read_recovery").length === 1,
      JSON.stringify(harness.state.calls.map((call) => call.command)),
    );
    expect(
      "the prompt said how many other backups are kept",
      harness.state.dialogs.some((dialog) =>
        String(dialog.message).includes("1 other backup kept."),
      ),
      JSON.stringify(harness.state.dialogs.map((dialog) => dialog.message)),
    );
    const raw = document.querySelector("#raw-editor");
    expect("the source editor is what is shown", visible(raw));
    expect(
      "the recovered text is in the source",
      raw.value.includes("Unsaved words"),
      raw.value,
    );
    expect(
      "the restored copy is not bound to the original file",
      document.querySelector("#status-path")?.textContent === "unsaved",
      document.querySelector("#status-path")?.textContent,
    );
    const title = lastTitle(harness);
    expect(
      "the recovered copy is marked unsaved",
      title?.name === "notes.md" && title?.dirty === true,
      JSON.stringify(title),
    );
  });

  await record("raw mode shows the source and returns to the editor", async (expect) => {
    // The recovered copy starts in raw mode; this scenario needs the editor.
    harness.answer("Discard");
    await open(harness, NOTES);
    await menu(harness, "raw");
    const raw = document.querySelector("#raw-editor");
    expect("the source editor is visible", visible(raw));
    expect("the rich editor is hidden", !visible(document.querySelector("#editor")));
    expect(
      "the source holds the document",
      raw.value.includes("# Title") && raw.value.includes("Hello world"),
      raw.value,
    );

    await menu(harness, "raw");
    expect("the rich editor is visible again", visible(document.querySelector("#editor")));
    expect("the source editor is hidden", !visible(document.querySelector("#raw-editor")));
    expect("the document is still rendered", text(editor()).includes("Hello world"));
    // A mode switch is not an edit: it must not ask to save on close.
    expect(
      "switching modes alone does not mark the document unsaved",
      lastTitle(harness)?.dirty === false,
      JSON.stringify(lastTitle(harness)),
    );
  });

  await record("the find bar shows while it is open", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    await keydown({ key: "f", ctrlKey: true });
    expect("the find bar is visible", visible(document.querySelector("#find-bar")));
    expect(
      "the find input takes focus",
      document.activeElement === document.querySelector("#find-input"),
      document.activeElement?.id,
    );

    document.querySelector("#find-close").click();
    await settle();
    expect("closing hides the find bar", !visible(document.querySelector("#find-bar")));
  });

  await record("opening a document through the menu loads it", async (expect) => {
    harness.reset();
    // The mode round trip can leave the buffer dirty, so answer the
    // unsaved-changes confirmation before opening.
    harness.answer("Discard");
    await open(harness, {
      path: "/tmp/other.md",
      name: "other.md",
      content: "# Other\n\nSecond file\n",
    });
    // The Open dialog returns the content itself; `load_document` is the
    // reload path, exercised by the focus-change scenarios.
    expect("the Open dialog was raised", harness.calls("open_document").length > 0);
    expect(
      "the editor shows the opened document",
      text(editor()).includes("Second file"),
      text(editor()),
    );
    expect(
      "the status bar follows the opened file",
      document.querySelector("#status-path")?.textContent === "/tmp/other.md",
      document.querySelector("#status-path")?.textContent,
    );
  });

  await record("saving writes the buffer and clears the unsaved mark", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    await editSource(harness, "A new line\n");
    expect("an edited document is marked unsaved", lastTitle(harness)?.dirty === true);

    harness.reset();
    await menu(harness, "save");
    const saved = harness.lastCall("save_document")?.args;
    expect("the document is written to its path", saved?.path === NOTES.path, saved?.path);
    expect(
      "the written content is the buffer",
      saved?.content?.includes("A new line"),
      saved?.content,
    );
    expect(
      "the file store holds the saved content",
      harness.state.files.get(NOTES.path) === saved?.content,
    );
    expect(
      "the document is no longer marked unsaved",
      lastTitle(harness)?.dirty === false,
      JSON.stringify(lastTitle(harness)),
    );
  });

  await record("overlapping transitions never mount two editors", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    harness.reset();

    // The race is transient: the loser's editor is torn down again, so the
    // final DOM can look fine. Track the highest number of editors mounted at
    // any instant instead, which is the state the user would see.
    const root = document.querySelector("#editor");
    let peak = 0;
    const observer = new MutationObserver(() => {
      peak = Math.max(peak, root.querySelectorAll(".ProseMirror").length);
    });
    observer.observe(root, { childList: true, subtree: true });

    // Both land in the same tick, so the second must supersede the first.
    harness.emit("menu-action", "new");
    harness.emit("menu-action", "new");
    await settledValue(() => root.querySelectorAll(".ProseMirror").length);
    observer.disconnect();

    expect("only one editor is ever mounted", peak === 1, `peak ${peak}`);
    const mounted = root.querySelectorAll(".ProseMirror").length;
    expect("exactly one editor is left", mounted === 1, `${mounted} mounted`);
  });

  await record("an outside change is adopted when nothing is unsaved", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    harness.file(NOTES.path, "# Title\n\nOutside edit\n");
    harness.reset();
    harness.report("changed", `token-${Date.now()}`);
    harness.emit("tauri://focus", {});
    await settle(200);

    expect("the file was re-read", harness.calls("load_document").length > 0);
    expect(
      "the editor shows the outside version",
      text(editor()).includes("Outside edit"),
      text(editor()),
    );
    expect(
      "a clean buffer is not prompted",
      harness.state.dialogs.length === 0,
      JSON.stringify(harness.state.dialogs),
    );
  });

  await record("unsaved edits are kept when the outside change is refused", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    await editSource(harness, "My unsaved line\n");

    harness.file(NOTES.path, "# Title\n\nOutside edit\n");
    harness.reset();
    harness.report("changed", `token-${Date.now()}`);
    harness.emit("tauri://focus", {});
    await settle(200);

    expect("the user is asked before replacing the buffer", harness.state.dialogs.length > 0);
    expect(
      "the unsaved text survives",
      text(editor()).includes("My unsaved line"),
      text(editor()),
    );
    expect("the outside version is not adopted", !text(editor()).includes("Outside edit"));
  });

  await record("a command that fails is reported, not dropped", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    await editSource(harness, "Unsaved line\n");
    harness.reset();
    // The confirmation must not answer from a label the open left queued:
    // this scenario needs the dialog invoke itself to fail. `ask` is the
    // plugin's `message` command, so that is the one to break.
    harness.state.answers.length = 0;
    harness.fail("plugin:dialog|message", 1);
    await menu(harness, "new");
    await settle(200);

    expect(
      "the failure is reported to the user",
      harness.state.dialogs.filter(
        (dialog) => dialog.title === "Could not run that command",
      ).length === 1,
      JSON.stringify(harness.state.dialogs),
    );
    expect(
      "nothing is left unhandled",
      harness.state.problems.length === 0,
      harness.state.problems.join("; "),
    );
    expect(
      "the refused command leaves the buffer alone",
      text(editor()).includes("Unsaved line"),
      JSON.stringify(text(editor())),
    );
  });

  await record("the table dialog and the toolbar menus announce themselves", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);

    // A <dialog> is not named by the heading inside it unless it says so.
    await menu(harness, "insert-table");
    await settle(120);
    const dialog = document.querySelector("dialog#insert-table");
    const labelId = dialog?.getAttribute("aria-labelledby") ?? "";
    expect("the table dialog is open", dialog?.open === true, String(dialog?.open));
    expect(
      "the dialog is named by its heading",
      document.getElementById(labelId)?.textContent === "Insert table",
      `${labelId} → ${document.getElementById(labelId)?.textContent}`,
    );
    dialog?.close("cancel");
    await settle();

    // The toolbar's menu triggers report whether their panel is open.
    editor().focus();
    document.execCommand("selectAll");
    await settle(120);
    const toolbar = document.querySelector(".selection-toolbar");
    expect("the selection toolbar is shown", visible(toolbar));
    const trigger = toolbar?.querySelector("button[aria-expanded]");
    expect(
      "a menu trigger starts collapsed",
      trigger?.getAttribute("aria-expanded") === "false",
      String(trigger?.getAttribute("aria-expanded")),
    );
    trigger?.click();
    await settle();
    expect(
      "opening its menu says so",
      trigger?.getAttribute("aria-expanded") === "true",
      String(trigger?.getAttribute("aria-expanded")),
    );
    trigger?.click();
    await settle();
    expect(
      "closing it says so again",
      trigger?.getAttribute("aria-expanded") === "false",
      String(trigger?.getAttribute("aria-expanded")),
    );
  });

  await record("replace all rewrites the document in rich mode", async (expect) => {
    harness.answer("Discard");
    await open(harness, NOTES);
    await keydown({ key: "f", ctrlKey: true });
    const find = document.querySelector("#find-input");
    find.value = "world";
    find.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    document.querySelector("#replace-toggle").click();
    await settle();
    expect("the replace row is shown", visible(document.querySelector("#replace-row")));
    const replace = document.querySelector("#replace-input");
    replace.value = "there";
    replace.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    document.querySelector("#replace-all").click();
    await settle(200);

    expect(
      "the editor shows the replacement",
      text(editor()).includes("Hello there"),
      text(editor()),
    );
    expect("the replaced text is gone", !text(editor()).includes("world"), text(editor()));

    // The replacement must reach the buffer, not just the rendered view.
    harness.reset();
    await menu(harness, "save");
    const saved = harness.lastCall("save_document")?.args;
    expect(
      "the saved content holds the replacement",
      saved?.content?.includes("Hello there"),
      saved?.content,
    );
  });

  await record("a mermaid block renders as a diagram", async (expect) => {
    harness.answer("Discard");
    await open(harness, {
      path: "/tmp/diagram.md",
      name: "diagram.md",
      content: "# Diagram\n\n```mermaid\ngraph TD; A-->B;\n```\n",
    });
    await settledValue(
      () => document.querySelector("#editor .mermaid-render svg")?.outerHTML.length ?? 0,
    );

    const rendered = document.querySelector("#editor .mermaid-render");
    expect(
      "the diagram is drawn and visible",
      visible(rendered) && Boolean(rendered?.querySelector("svg")),
      rendered?.className,
    );
    expect(
      "no render error is shown",
      !visible(document.querySelector("#editor .mermaid-error")),
    );
    expect(
      "the fence source stays editable beside it",
      document.querySelector("#editor .mermaid-block pre code")?.textContent?.includes("graph TD") === true,
      document.querySelector("#editor .mermaid-block pre code")?.textContent,
    );
  });

  await record("a byte-order mark survives a save", async (expect) => {
    harness.answer("Discard");
    await open(harness, {
      path: "/tmp/bom.md",
      name: "bom.md",
      content: "\uFEFF# Title\n\nHello world\n",
    });
    harness.reset();
    await menu(harness, "save");
    const saved = harness.lastCall("save_document")?.args;

    expect(
      "the saved file still starts with the mark",
      saved?.content?.startsWith("\uFEFF") === true,
      JSON.stringify(saved?.content?.slice(0, 12)),
    );
    expect(
      "the mark is not duplicated",
      saved?.content?.indexOf("\uFEFF", 1) === -1,
      JSON.stringify(saved?.content?.slice(0, 12)),
    );
    expect(
      "the text is otherwise unchanged",
      saved?.content === "\uFEFF# Title\n\nHello world\n",
      JSON.stringify(saved?.content),
    );
  });

  await record("a document with an untitled image opens", async (expect) => {
    harness.answer("Discard");
    await open(harness, {
      path: "/tmp/untitled-image.md",
      name: "untitled-image.md",
      content: "# Title\n\n![](a.png) ![alt](b.png) ![alt](c.png \"title\")\n",
    });
    harness.reset();
    await menu(harness, "save");
    const saved = harness.lastCall("save_document")?.args?.content;

    expect(
      "every image is in the editor",
      document.querySelectorAll("#editor img:not(.ProseMirror-separator)").length === 3,
      document.querySelector("#editor")?.innerHTML.slice(0, 200),
    );
    expect(
      "saving writes the images back unchanged",
      saved === "# Title\n\n![](a.png) ![alt](b.png) ![alt](c.png \"title\")\n",
      JSON.stringify(saved),
    );
  });

  await record("local images load and remote images wait to be allowed", async (expect) => {
    harness.answer("Discard");
    await open(harness, {
      path: "/tmp/pictures/images.md",
      name: "images.md",
      content: "![local](img/a.png) ![remote](https://example.invalid/b.png)\n",
    });
    const image = (alt) => document.querySelector(`#editor img[alt="${alt}"]`);
    const placeholder = () => document.querySelector("#editor .md-image-blocked:not([hidden])");

    expect(
      "a relative image loads from the document's folder",
      image("local")?.getAttribute("src") === "/tmp/pictures/img/a.png",
      image("local")?.getAttribute("src"),
    );
    expect(
      "a remote image is not requested",
      !image("remote")?.hasAttribute("src") && !visible(image("remote")),
      image("remote")?.getAttribute("src"),
    );
    expect("a placeholder stands in for it", text(placeholder()) === "remote", text(placeholder()));

    await menu(harness, "remote-images");
    expect(
      "allowing remote images loads it",
      image("remote")?.getAttribute("src") === "https://example.invalid/b.png" && !placeholder(),
      image("remote")?.getAttribute("src"),
    );
    await menu(harness, "remote-images");
    expect("turning them off again blocks it", Boolean(placeholder()));
  });

  return {
    ok: scenarios.every((scenario) => scenario.ok),
    scenarios,
    problems: harness.state.problems,
  };
}
