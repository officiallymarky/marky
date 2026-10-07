import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@milkdown/kit/prose/state";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import type { MarkdownNode, NodeSchema } from "@milkdown/kit/transformer";
import { $inputRule, $node, $prose, $remark } from "@milkdown/kit/utils";

const markerPattern = /^(?:\[TOC\]|\[\[TOC\]\])$/i;

export interface TocHeading {
  text: string;
  id: string;
  pos: number;
  level: number;
  depth: number;
}

export interface HeadingRecord {
  text: string;
  pos: number;
  level: number;
  id?: string;
}

/** Nesting depth comes from the running stack of still-open heading levels. */
export function collectHeadings(records: Iterable<HeadingRecord>): TocHeading[] {
  const headings: TocHeading[] = [];
  const levels: number[] = [];
  for (const { text, pos, level, id } of records) {
    while (levels.length && levels[levels.length - 1] >= level) levels.pop();
    headings.push({ text, id: id ?? "", pos, level, depth: levels.length });
    levels.push(level);
  }
  return headings;
}

/** Heading positions keep duplicate titles navigable without inventing IDs. */
export function collectTocHeadings(doc: ProseNode): TocHeading[] {
  const records: HeadingRecord[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading" || !node.textContent.trim()) return;
    records.push({
      text: node.textContent,
      id: String(node.attrs.id ?? ""),
      pos,
      level: Number(node.attrs.level),
    });
    return false;
  });
  return collectHeadings(records);
}

/** Selects and reveals a heading in the rich editor. */
export function jumpToHeading(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))));
  view.focus();
  const target = view.nodeDOM(pos);
  if (target instanceof HTMLElement) target.scrollIntoView({ block: "start" });
}

export const tocSchema: NodeSchema = {
  group: "block",
  atom: true,
  attrs: { marker: { default: "[TOC]" } },
  parseDOM: [{
    tag: "nav[data-toc-marker]",
    getAttrs: (dom) => {
      const marker = dom.getAttribute("data-toc-marker") ?? "";
      return markerPattern.test(marker) ? { marker } : false;
    },
  }],
  toDOM: (node) => ["nav", { "data-toc-marker": node.attrs.marker }, node.attrs.marker],
  parseMarkdown: {
    match: (node) => node.type === "markyToc",
    runner: (state, node, type) => {
      state.addNode(type, { marker: node.value });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "toc",
    runner: (state, node) => {
      state.addNode("markyToc", undefined, node.attrs.marker);
    },
  },
};

export const tocNode = $node("toc", () => tocSchema);

// A custom Markdown handler preserves the marker instead of letting remark
// escape its brackets. Source positions distinguish markers from escaped text.
export const tocRemark = $remark("markyToc", () => function () {
  const extensions = this.data("toMarkdownExtensions") ?? [];
  const handlers: Record<string, (node: MarkdownNode) => string> = {
    markyToc: (node) => String(node.value),
  };
  this.data("toMarkdownExtensions", [...extensions, { handlers }]);
  return (tree, file) => {
    const source = String(file.value);
    // Only document-level paragraphs are directives. List items, quotes and
    // other nested content must keep their normal Markdown structure.
    const root = tree as unknown as MarkdownNode;
    root.children?.forEach((node, index) => {
      if (node.type !== "paragraph") return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const marker = start === undefined || end === undefined
        ? ""
        : source.slice(start, end).trim();
      if (markerPattern.test(marker)) {
        root.children![index] = {
          type: "markyToc",
          value: marker,
          position: node.position,
        };
      }
    });
  };
});

/** Convert only a complete, unformatted marker at the end of a paragraph. */
export function createTocInputRule(type: NodeType): InputRule {
  return new InputRule(/^(?:\[TOC\]|\[\[TOC\]\])$/i, (state, match) => {
    const { $from, $to } = state.selection;
    if ($from.depth !== 1 || $from.parent.type.name !== "paragraph" || !$from.sameParent($to) ||
        $to.parentOffset !== $to.parent.content.size ||
        $from.parent.content.content.some((node) => node.marks.length > 0)) return null;
    const start = $from.before();
    const tr = state.tr.replaceWith(start, $from.after(), type.create({ marker: match[0] }));
    // A block at document end needs somewhere to continue typing.
    if (start + 1 === tr.doc.content.size) {
      tr.insert(tr.doc.content.size, state.schema.nodes.paragraph.create());
    }
    return tr.setSelection(Selection.near(tr.doc.resolve(start + 1))).scrollIntoView();
  });
}

export const tocInputRule = $inputRule((ctx) => createTocInputRule(tocNode.type(ctx)));

const tocKey = new PluginKey<readonly TocHeading[]>("MARKY_TOC");

class TocView implements NodeView {
  dom: HTMLElement;
  private list: HTMLUListElement;
  private empty: HTMLElement;
  private marker: HTMLElement;

  private view: EditorView;

  constructor(node: ProseNode, view: EditorView) {
    this.view = view;
    this.dom = document.createElement("nav");
    this.dom.className = "md-toc";
    this.dom.contentEditable = "false";
    this.dom.setAttribute("aria-label", "Table of contents");
    const header = document.createElement("div");
    header.className = "md-toc-header";
    const title = document.createElement("span");
    title.textContent = "Contents";
    this.marker = document.createElement("span");
    this.marker.className = "md-toc-marker";
    header.append(title, this.marker);
    this.list = document.createElement("ul");
    this.empty = document.createElement("p");
    this.empty.className = "md-toc-empty";
    this.empty.textContent = "Add headings to build a table of contents.";
    this.dom.append(header, this.list, this.empty);
    this.update(node);
    this.render(tocKey.getState(view.state) ?? []);
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== "toc") return false;
    this.dom.dataset.tocMarker = node.attrs.marker;
    this.marker.textContent = node.attrs.marker;
    return true;
  }

  render(headings: readonly TocHeading[]): void {
    this.list.replaceChildren();
    this.list.hidden = headings.length === 0;
    this.empty.hidden = headings.length !== 0;
    const lists = [this.list];
    for (const heading of headings) {
      if (heading.depth === lists.length) {
        const nested = document.createElement("ul");
        lists[lists.length - 1].lastElementChild!.append(nested);
        lists.push(nested);
      }
      lists.length = heading.depth + 1;
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = heading.text;
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.addEventListener("mousedown", (event) => event.preventDefault());
      link.addEventListener("click", (event) => {
        event.preventDefault();
        jumpToHeading(this.view, heading.pos);
      });
      item.append(link);
      lists[heading.depth].append(item);
    }
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Element && Boolean(event.target.closest("a"));
  }

  ignoreMutation(): boolean {
    return true;
  }
}

export const tocPlugin = $prose(() => {
  const views = new Set<TocView>();
  return new Plugin<readonly TocHeading[]>({
    key: tocKey,
    state: {
      init: (_config, state) => collectTocHeadings(state.doc),
      apply: (tr, previous) => {
        if (!tr.docChanged) return previous;
        const headings = collectTocHeadings(tr.doc);
        return headings.length === previous.length && headings.every((heading, i) => {
          const old = previous[i];
          return heading.pos === old.pos && heading.text === old.text &&
            heading.id === old.id && heading.level === old.level && heading.depth === old.depth;
        }) ? previous : headings;
      },
    },
    props: {
      nodeViews: {
        toc: (node, view) => {
          const toc = new TocView(node, view);
          views.add(toc);
          return Object.assign(toc, { destroy: () => views.delete(toc) });
        },
      },
    },
    view: () => ({
      update: (view, previous) => {
        const headings = tocKey.getState(view.state)!;
        if (headings === tocKey.getState(previous)) return;
        for (const toc of views) toc.render(headings);
      },
      destroy: () => views.clear(),
    }),
  });
});
