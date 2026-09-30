import type { EditorView } from "@milkdown/kit/prose/view";
import { ALERT_KINDS, type AlertKind } from "./alerts";

/** Formatting actions the toolbar can trigger; the editor wires them to commands. */
export interface ToolbarActions {
  bold(): void;
  italic(): void;
  code(): void;
  strike(): void;
  link(href: string): void;
  image(src: string, alt: string): void;
  quote(): void;
  bullet(): void;
  ordered(): void;
  taskList(): void;
  heading(level: number): void;
  paragraph(): void;
  codeBlock(): void;
  insertCodeBlock(): void;
  table(rows: number, cols: number): void;
  horizontalRule(): void;
  alert(kind: AlertKind): void;
  footnote(): void;
}

const SVG_ICONS: Record<string, string> = {
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5 9.5 6.5M4.75 7.25 3.4 8.6a2.5 2.5 0 0 0 3.54 3.54l1.35-1.35m2.96-2.08 1.35-1.35A2.5 2.5 0 0 0 9.06 3.82L7.7 5.17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.4" cy="6.1" r="1.15" fill="currentColor"/><path d="m3.4 11.6 2.8-2.8 2 2 2.2-2.2 2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  quote:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.6c-1.3.6-2.1 1.7-2.1 3.2 0 1.2.8 2 1.8 2 1 0 1.7-.7 1.7-1.7 0-.9-.6-1.5-1.4-1.6.2-.8.8-1.4 1.6-1.7zM10.4 4.6c-1.3.6-2.1 1.7-2.1 3.2 0 1.2.8 2 1.8 2 1 0 1.7-.7 1.7-1.7 0-.9-.6-1.5-1.4-1.6.2-.8.8-1.4 1.6-1.7z" fill="currentColor"/></svg>',
  list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/></svg>',
  olist:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.2 3.1 1.5-.9v5.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 11c0-1 .7-1.7 1.6-1.7s1.7.6 1.7 1.4c0 .9-.6 1.4-1.4 2L3.2 14.4h4.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 4.25h6M8 11.75h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  task:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.5 8.1 1.9 1.9 3.4-3.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  table:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.75 6.25h12.5M1.75 9.75h12.5M6.25 2.75v10.5M10.75 2.75v10.5" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  hr:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="2.25" cy="8" r="1" fill="currentColor"/><circle cx="13.75" cy="8" r="1" fill="currentColor"/></svg>',
  codeblock:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m6.4 6.3-1.9 1.7 1.9 1.7M9.6 6.3l1.9 1.7-1.9 1.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 14.4 13.4H1.6Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.3v3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".95" fill="currentColor"/></svg>',
  footnote:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4v11.2M3.1 5.1l9.8 5.8M12.9 5.1l-9.8 5.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

/** Only one editor toolbar exists at a time; popover internals close via this. */
let active: SelectionToolbar | null = null;

interface SelectionToolbar {
  closeMenus(): void;
  closePopovers(): void;
}

function button(content: string, title: string, className = ""): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `tb-btn ${className}`.trim();
  el.title = title;
  el.setAttribute("aria-label", title);
  if (content.startsWith("<svg")) el.innerHTML = content;
  else el.textContent = content;
  return el;
}

function separator(): HTMLElement {
  const el = document.createElement("span");
  el.className = "tb-sep";
  return el;
}

/**
 * Typora-style floating selection toolbar, fixed at the bottom-center: shows
 * while the editor is focused with a selection or an open popover, and
 * applies formatting through the editor's commands. Owns its DOM under
 * `document.body`; call `destroy()` with the editor.
 */
export function createSelectionToolbar(options: {
  view: EditorView;
  actions: ToolbarActions;
}): { destroy(): void } {
  const { view, actions } = options;

  const root = document.createElement("div");
  root.className = "selection-toolbar";
  root.hidden = true;

  const run = (action: () => void): void => {
    action();
    view.focus();
    refresh();
  };

  // --- popovers (link / image) ---------------------------------------------
  const buildPopover = (
    fields: Array<[string, string, string]>,
    submitLabel: string,
    onSubmit: (values: string[]) => void,
  ): { panel: HTMLDivElement; firstInput: HTMLInputElement } => {
    const panel = document.createElement("div");
    panel.className = "tb-popover";
    panel.hidden = true;
    const inputs = fields.map(([name, placeholder, type]) => {
      const input = document.createElement("input");
      input.name = name;
      input.type = type;
      input.placeholder = placeholder;
      panel.append(input);
      return input;
    });
    const row = document.createElement("div");
    row.className = "tb-popover-row";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tb-popover-btn";
    cancel.textContent = "Cancel";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "tb-popover-btn primary";
    submit.textContent = submitLabel;
    const apply = () => {
      const values = inputs.map((input) => input.value.trim());
      if (values.some(Boolean)) onSubmit(values);
      controls.closePopovers();
    };
    submit.addEventListener("click", apply);
    cancel.addEventListener("click", () => controls.closePopovers());
    for (const input of inputs) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
        }
      });
    }
    row.append(cancel, submit);
    panel.append(row);
    return { panel, firstInput: inputs[0]! };
  };

  const linkPopover = buildPopover(
    [["href", "https://example.com", "url"]],
    "Link",
    ([href]) => {
      if (href) run(() => actions.link(href));
    },
  );
  const imagePopover = buildPopover(
    [
      ["src", "Image URL", "url"],
      ["alt", "Description (alt)", "text"],
    ],
    "Insert",
    ([src, alt]) => {
      if (src) run(() => actions.image(src, alt));
    },
  );

  const controls: SelectionToolbar = {
    closeMenus: () => {
      window.clearTimeout(submenuTimer);
      paragraphMenu.hidden = true;
      listMenu.hidden = true;
      insertMenu.hidden = true;
      tablePanel.hidden = true;
      alertPanel.hidden = true;
    },
    closePopovers: () => {
      linkPopover.panel.hidden = true;
      imagePopover.panel.hidden = true;
    },
  };

  // --- dropdown menus -------------------------------------------------------
  interface MenuItemSpec {
    label: string;
    action: () => void;
    icon?: string;
  }
  const buildMenuItem = ({
    label,
    action,
    icon,
  }: MenuItemSpec): HTMLButtonElement => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tb-menu-item";
    if (icon) {
      const glyph = document.createElement("span");
      glyph.className = "tb-menu-icon";
      glyph.innerHTML = icon;
      item.append(glyph);
    }
    item.append(label);
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      controls.closeMenus();
      run(action);
    });
    return item;
  };
  const buildMenu = (items: Array<MenuItemSpec>): HTMLDivElement => {
    const menu = document.createElement("div");
    menu.className = "tb-menu";
    menu.hidden = true;
    for (const item of items) menu.append(buildMenuItem(item));
    return menu;
  };
  const paragraphMenu = buildMenu([
    { label: "Paragraph", action: actions.paragraph },
    { label: "Heading 1", action: () => actions.heading(1) },
    { label: "Heading 2", action: () => actions.heading(2) },
    { label: "Heading 3", action: () => actions.heading(3) },
    { label: "Heading 4", action: () => actions.heading(4) },
    { label: "Heading 5", action: () => actions.heading(5) },
    { label: "Heading 6", action: () => actions.heading(6) },
    { label: "Code Block", action: actions.codeBlock },
  ]);
  const listMenu = buildMenu([
    { label: "Unordered list", action: actions.bullet, icon: SVG_ICONS.list },
    { label: "Ordered list", action: actions.ordered, icon: SVG_ICONS.olist },
    { label: "Task list", action: actions.taskList, icon: SVG_ICONS.task },
  ]);

  // --- insert menu ----------------------------------------------------------
  const tablePanel = document.createElement("div");
  tablePanel.className = "tb-submenu tb-table-panel";
  tablePanel.hidden = true;
  const tableLabel = document.createElement("div");
  tableLabel.className = "tb-table-label";
  tableLabel.textContent = "Rows × Columns";
  const tableGrid = document.createElement("div");
  tableGrid.className = "tb-table-grid";
  const MAX_COLS = 6;
  const MAX_ROWS = 5;
  const gridCells: HTMLButtonElement[] = [];
  const highlightTable = (cols: number, rows: number): void => {
    for (let i = 0; i < gridCells.length; i += 1) {
      const cellRow = Math.floor(i / MAX_COLS) + 1;
      const cellCol = (i % MAX_COLS) + 1;
      gridCells[i]!.classList.toggle("on", cellRow <= rows && cellCol <= cols);
    }
    tableLabel.textContent = `${cols} × ${rows} table`;
  };
  for (let r = 1; r <= MAX_ROWS; r += 1) {
    for (let c = 1; c <= MAX_COLS; c += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "tb-table-cell";
      cell.setAttribute("aria-label", `${c} by ${r} table`);
      cell.addEventListener("mousedown", (event) => event.preventDefault());
      cell.addEventListener("mouseenter", () => highlightTable(c, r));
      cell.addEventListener("click", () => {
        controls.closeMenus();
        run(() => actions.table(r, c));
      });
      gridCells.push(cell);
      tableGrid.append(cell);
    }
  }
  tableGrid.addEventListener("mouseleave", () => {
    for (const cell of gridCells) cell.classList.remove("on");
    tableLabel.textContent = "Rows × Columns";
  });
  tablePanel.append(tableLabel, tableGrid);

  const alertPanel = buildMenu(
    ALERT_KINDS.map((kind) => ({
      label: kind[0]!.toUpperCase() + kind.slice(1),
      action: () => actions.alert(kind),
    })),
  );
  alertPanel.classList.add("tb-submenu");

  /** Hover- or click-opened trigger item with a second-level panel. */
  let submenuTimer: number | undefined;
  const closeSubmenus = (): void => {
    window.clearTimeout(submenuTimer);
    tablePanel.hidden = true;
    alertPanel.hidden = true;
  };
  const submenuHost = (label: string, panel: HTMLDivElement): HTMLDivElement => {
    const host = document.createElement("div");
    host.className = "tb-menu-host";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "tb-menu-item tb-submenu-trigger";
    const arrow = document.createElement("span");
    arrow.className = "tb-submenu-arrow";
    trigger.append(label, arrow);
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.addEventListener("click", () => {
      const willOpen = panel.hidden;
      closeSubmenus();
      panel.hidden = !willOpen;
    });
    host.addEventListener("mouseenter", () => {
      window.clearTimeout(submenuTimer);
      closeSubmenus();
      panel.hidden = false;
    });
    host.addEventListener("mouseleave", () => {
      submenuTimer = window.setTimeout(() => {
        panel.hidden = true;
      }, 150);
    });
    host.append(trigger, panel);
    return host;
  };
  const tableHost = submenuHost("Table", tablePanel);
  const alertHost = submenuHost("Alert", alertPanel);

  const insertMenu = document.createElement("div");
  insertMenu.className = "tb-menu";
  insertMenu.hidden = true;
  insertMenu.append(
    tableHost,
    buildMenuItem({
      label: "Horizontal Line",
      action: actions.horizontalRule,
      icon: SVG_ICONS.hr,
    }),
    buildMenuItem({
      label: "Code Block",
      action: actions.insertCodeBlock,
      icon: SVG_ICONS.codeblock,
    }),
    alertHost,
    buildMenuItem({
      label: "Footnote",
      action: actions.footnote,
      icon: SVG_ICONS.footnote,
    }),
  );

  // --- buttons --------------------------------------------------------------
  const paragraphButton = button("Paragraph ▾", "Block type", "tb-label");
  const listButton = button(SVG_ICONS.list, "Lists", "tb-icon");
  const boldBtn = button("B", "Bold", "tb-b");
  const italicBtn = button("I", "Italic", "tb-i");
  const strikeBtn = button("S", "Strikethrough", "tb-s");
  const codeBtn = button("</>", "Inline code", "tb-code");
  const linkBtn = button(SVG_ICONS.link, "Link", "tb-icon");
  const imageBtn = button(SVG_ICONS.image, "Image", "tb-icon");
  const quoteBtn = button(SVG_ICONS.quote, "Blockquote", "tb-icon");
  const insertButton = button("Insert ▾", "Insert", "tb-label");

  const simpleActions: Array<[HTMLButtonElement, () => void]> = [
    [boldBtn, actions.bold],
    [italicBtn, actions.italic],
    [strikeBtn, actions.strike],
    [codeBtn, actions.code],
    [quoteBtn, actions.quote],
  ];
  for (const [el, action] of simpleActions) {
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => run(action));
  }
  const menuButtons: Array<[HTMLButtonElement, HTMLDivElement]> = [
    [paragraphButton, paragraphMenu],
    [listButton, listMenu],
    [insertButton, insertMenu],
  ];
  for (const [el, menu] of menuButtons) {
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => {
      const willOpen = menu.hidden;
      controls.closeMenus();
      controls.closePopovers();
      menu.hidden = !willOpen;
      if (willOpen) refreshStates();
    });
  }
  const popoverButtons: Array<[HTMLButtonElement, typeof linkPopover]> = [
    [linkBtn, linkPopover],
    [imageBtn, imagePopover],
  ];
  for (const [el, popover] of popoverButtons) {
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", () => {
      const willOpen = popover.panel.hidden;
      controls.closeMenus();
      controls.closePopovers();
      popover.panel.hidden = !willOpen;
      if (willOpen) popover.firstInput.focus();
    });
  }

  root.append(
    paragraphButton,
    separator(),
    boldBtn,
    italicBtn,
    strikeBtn,
    codeBtn,
    separator(),
    linkBtn,
    imageBtn,
    quoteBtn,
    listButton,
    separator(),
    insertButton,
    separator(),
    paragraphMenu,
    listMenu,
    insertMenu,
    linkPopover.panel,
    imagePopover.panel,
  );
  document.body.append(root);

  let visible = false;

  function refresh(): void {
    if (!view.hasFocus() && !anyPanelOpen()) {
      hide();
      return;
    }
    root.hidden = false;
    refreshStates();
    visible = true;
  }

  /** Any open menu/popover keeps the toolbar visible while the editor is unfocused. */
  function anyPanelOpen(): boolean {
    return (
      !linkPopover.panel.hidden ||
      !imagePopover.panel.hidden ||
      !paragraphMenu.hidden ||
      !listMenu.hidden ||
      !insertMenu.hidden
    );
  }

  /** Block type label + button active states for the current selection. */
  function refreshStates(): void {
    const { state } = view;
    const { from, to, empty, $from } = state.selection;
    const has = (name: string): boolean => {
      const type = state.schema.marks[name];
      if (!type) return false;
      return empty
        ? $from.marks().some((mark) => mark.type === type)
        : state.doc.rangeHasMark(from, to, type);
    };
    boldBtn.classList.toggle("active", has("strong"));
    italicBtn.classList.toggle("active", has("emphasis"));
    strikeBtn.classList.toggle("active", has("strike_through"));
    codeBtn.classList.toggle("active", has("inline_code"));

    const parent = $from.parent;
    let label = "Paragraph";
    if (parent.type.name === "heading") {
      label = `Heading ${(parent.attrs.level as number) ?? 1}`;
    } else if (parent.type.name === "code_block") {
      label = "Code Block";
    }
    paragraphButton.textContent = `${label} ▾`;
    for (const item of paragraphMenu.querySelectorAll<HTMLElement>(".tb-menu-item")) {
      item.classList.toggle("active", item.textContent === label);
    }
    let inList = false;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const name = $from.node(depth).type.name;
      if (name === "bullet_list" || name === "ordered_list") inList = true;
    }
    listButton.classList.toggle("active", inList);
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    controls.closeMenus();
    controls.closePopovers();
    root.hidden = true;
  }

  const onSelectionChange = () => {
    if (!view.hasFocus() && !visible) return;
    refresh();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!visible) return;
    if (event.key === "Escape") {
      hide();
      view.focus();
      event.stopPropagation();
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!visible) return;
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    controls.closeMenus();
    controls.closePopovers();
    if (!(target instanceof Node && view.dom.contains(target))) hide();
  };

  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("focusin", onSelectionChange);
  document.addEventListener("focusout", onSelectionChange);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);

  active = controls;

  return {
    destroy() {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("focusin", onSelectionChange);
      document.removeEventListener("focusout", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      root.remove();
      if (active === controls) active = null;
    },
  };
}
