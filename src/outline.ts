import type { MarkdownNode } from "@milkdown/kit/transformer";
import { collectHeadings, type HeadingRecord, type TocHeading } from "./toc";
import { splitFrontmatter } from "./frontmatter";

/** Largest heading top margin (h1: 0.9em, ~27px) plus slack, so a section stays
 *  current until its heading actually clears the viewport top. */
const HEADING_TOP_MARGIN = 64;

/** Use the editor's Markdown parser so fences, Setext headings and nesting agree. */
export function collectSourceHeadings(
  source: string,
  parse: (body: string) => MarkdownNode,
): TocHeading[] {
  const { body } = splitFrontmatter(source);
  const offset = source.length - body.length;
  const records: HeadingRecord[] = [];
  const text = (node: MarkdownNode): string => {
    if (node.type === "image") return String(node.alt ?? "");
    return node.children?.map(text).join("") ?? String(node.value ?? "");
  };
  const walk = (node: MarkdownNode): void => {
    if (node.type === "heading") {
      const title = text(node);
      const start = node.position?.start.offset;
      if (!title.trim() || start === undefined) return;
      records.push({ text: title, pos: start + offset, level: Number(node.depth) });
      return;
    }
    node.children?.forEach(walk);
  };
  walk(parse(body));
  return collectHeadings(records);
}

/** Measure wrapped source lines without changing the textarea's contents or undo. */
export function scrollSourceTo(editor: HTMLTextAreaElement, pos: number): void {
  const mirror = document.createElement("div");
  const styles = getComputedStyle(editor);
  for (const property of ["font", "line-height", "letter-spacing", "tab-size", "padding", "box-sizing"]) {
    mirror.style.setProperty(property, styles.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", width: `${editor.clientWidth}px`,
    whiteSpace: "pre-wrap", overflowWrap: "break-word", top: "0", left: "0",
  });
  mirror.textContent = editor.value.slice(0, pos);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 3);
  mirror.remove();
}

type OutlineOptions = {
  editorRoot: HTMLElement;
  rawEditor: HTMLTextAreaElement;
  headings(): readonly TocHeading[];
  currentPosition(): number;
  sourceMode(): boolean;
  headingTop(pos: number): number | null;
  jump(pos: number): void;
  focusEditor(): void;
};

export function createOutlinePanel(options: OutlineOptions) {
  const panel = document.getElementById("outline-panel")!;
  const list = document.getElementById("outline-list")!;
  const empty = document.getElementById("outline-empty")!;
  const toggle = document.getElementById("status-outline")!;
  const close = document.getElementById("outline-close")!;
  const scroller = document.getElementById("app")!;
  let headings: readonly TocHeading[] = [];
  let buttons: HTMLButtonElement[] = [];
  let current = -1;
  let frame = 0;

  function updateCurrent(useSelection = true): void {
    if (panel.hidden) return;
    const position = useSelection || options.sourceMode() ? options.currentPosition() : null;
    const edge = scroller.getBoundingClientRect().top + HEADING_TOP_MARGIN;
    let next = position === null && headings.length ? 0 : -1;
    for (let index = 0; index < headings.length; index++) {
      if (position !== null) {
        if (headings[index].pos > position) break;
      } else {
        const top = options.headingTop(headings[index].pos);
        if (top === null || top > edge) break;
      }
      next = index;
    }
    if (next === current) return;
    if (current >= 0) buttons[current]?.removeAttribute("aria-current");
    current = next;
    if (current >= 0) buttons[current]?.setAttribute("aria-current", "location");
  }

  function refresh(): void {
    if (panel.hidden) return;
    const next = options.headings();
    const changed = next.length !== headings.length || next.some((heading, index) => {
      const old = headings[index];
      return heading.text !== old.text || heading.pos !== old.pos || heading.depth !== old.depth;
    });
    if (changed) {
      const focused = buttons.indexOf(document.activeElement as HTMLButtonElement);
      headings = next;
      buttons = headings.map((heading) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = heading.text;
        button.title = heading.text;
        button.style.setProperty("--outline-depth", String(heading.depth));
        button.addEventListener("click", () => {
          options.jump(heading.pos);
          updateCurrent();
        });
        return button;
      });
      const items = buttons.map((button) => {
        const item = document.createElement("li");
        item.append(button);
        return item;
      });
      list.replaceChildren(...items);
      current = -1;
      if (focused >= 0) (buttons[Math.min(focused, buttons.length - 1)] ?? close).focus();
    }
    empty.hidden = headings.length !== 0;
    list.hidden = headings.length === 0;
    updateCurrent();
  }

  function scheduleRefresh(): void {
    if (panel.hidden || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function setOpen(on: boolean): void {
    const containedFocus = panel.contains(document.activeElement);
    panel.hidden = !on;
    toggle.setAttribute("aria-expanded", String(on));
    if (on) {
      refresh();
      (buttons[current >= 0 ? current : 0] ?? close).focus();
    } else if (containedFocus) {
      options.focusEditor();
    }
  }

  toggle.addEventListener("click", () => setOpen(Boolean(panel.hidden)));
  close.addEventListener("click", () => setOpen(false));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = Math.min(index + 1, buttons.length - 1); break;
      case "ArrowUp": next = Math.max(index - 1, 0); break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next].focus();
  });
  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(options.editorRoot, { childList: true, subtree: true, characterData: true });
  options.rawEditor.addEventListener("input", scheduleRefresh);
  options.rawEditor.addEventListener("select", () => updateCurrent());
  document.addEventListener("selectionchange", () => updateCurrent());
  scroller.addEventListener("scroll", () => updateCurrent(false), { passive: true });
  window.addEventListener("resize", () => updateCurrent(false));

  return { toggle: () => setOpen(Boolean(panel.hidden)), refresh: scheduleRefresh };
}
