import { Plugin } from "@milkdown/kit/prose/state";
import { THEME_CHANGED_EVENT } from "./theme";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { ViewMutationRecord } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import mermaid from "mermaid";
import { IMAGES_CHANGED_EVENT, remoteImagesAllowed } from "./images";
import { hasRemoteMermaidImages } from "./mermaid-images";
import { parseSanitizedMermaidSvg } from "./mermaid-svg";

const RENDER_DEBOUNCE_MS = 300;
// Shared across all node views: mermaid reuses an existing element with the
// given id, so ids must be globally unique, not per view.
let nextMermaidId = 0;
// The image preflight and draw must share the same Mermaid configuration/DB.
let renderQueue = Promise.resolve();

/**
 * Node view for `code_block` nodes: keeps the fence source editable and, for
 * `mermaid` fences, renders the diagram live underneath. Non-mermaid code
 * blocks simply show their source, so the view is safe to attach to all
 * code blocks.
 */
class MermaidBlockView {
  private themeListener = () => this.scheduleRender();
  private imagesListener = () => {
    this.reset();
    this.scheduleRender();
  };
  dom: HTMLElement;
  contentDOM: HTMLElement;

  private node: ProseNode;
  private diagramEl: HTMLElement;
  private errorEl: HTMLElement;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderedText: string | null = null;
  private renderSeq = 0;
  private resizeObserver = new ResizeObserver(() => this.applySvgSize());

  constructor(node: ProseNode) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.classList.toggle("mermaid-block", this.isMermaid(node));

    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    pre.appendChild(this.contentDOM);

    this.diagramEl = document.createElement("div");
    this.diagramEl.className = "mermaid-render";
    this.diagramEl.hidden = true;

    this.errorEl = document.createElement("div");
    this.errorEl.className = "mermaid-error";
    this.errorEl.hidden = true;

    this.dom.append(pre, this.diagramEl, this.errorEl);
    this.resizeObserver.observe(this.diagramEl);
    document.addEventListener(THEME_CHANGED_EVENT, this.themeListener);
    document.addEventListener(IMAGES_CHANGED_EVENT, this.imagesListener);
    this.scheduleRender();
  }

  private isMermaid(node: ProseNode): boolean {
    return node.attrs.language === "mermaid";
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== "code_block") return false;
    this.node = node;
    const mermaid = this.isMermaid(node);
    this.dom.classList.toggle("mermaid-block", mermaid);
    if (!mermaid || node.textContent !== this.lastRenderedText) {
      this.scheduleRender();
    }
    return true;
  }

  // The diagram and error panes are rendered by us, not ProseMirror.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return (
      this.diagramEl.contains(mutation.target) ||
      this.errorEl.contains(mutation.target)
    );
  }

  // Only events aimed at our rendered panes are ours to swallow. A blanket
  // `true` would also drop every event from the editable fence source, and
  // ProseMirror never runs its keymaps (the code-block Tab indent) without them.
  stopEvent(event: Event): boolean {
    const target = event.target;
    return (
      target instanceof Node &&
      (this.diagramEl.contains(target) || this.errorEl.contains(target))
    );
  }

  destroy(): void {
    this.renderSeq += 1;
    clearTimeout(this.renderTimer);
    this.resizeObserver.disconnect();
    document.removeEventListener(THEME_CHANGED_EVENT, this.themeListener);
    document.removeEventListener(IMAGES_CHANGED_EVENT, this.imagesListener);
  }

  /**
   * WebKit does not derive a height for a `viewBox`-only SVG the way Blink
   * does, so the diagram collapses and paints over following content. Size
   * every rendered SVG explicitly from its viewBox and the container width,
   * and keep that correct on resizes.
   */
  private applySvgSize() {
    const svgEl = this.diagramEl.querySelector("svg");
    if (!svgEl || this.diagramEl.hidden) return;
    const viewBox = svgEl.getAttribute("viewBox");
    if (!viewBox) return;
    const [, , vbWidth, vbHeight] = viewBox.split(/[\s,]+/).map(Number);
    if (!vbWidth || !vbHeight) return;
    const width = this.diagramEl.clientWidth || vbWidth;
    const scale = Math.min(1, width / vbWidth);
    svgEl.style.width = `${Math.round(vbWidth * scale)}px`;
    svgEl.style.height = `${Math.round(vbHeight * scale)}px`;
  }

  private scheduleRender() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    const seq = ++this.renderSeq;
    this.renderTimer = setTimeout(() => {
      renderQueue = renderQueue.then(async () => {
        if (seq === this.renderSeq) await this.render(seq);
      });
    }, RENDER_DEBOUNCE_MS);
  }

  private async render(seq: number) {
    const text = this.node.textContent;
    this.lastRenderedText = text;

    if (!this.isMermaid(this.node) || !text.trim()) {
      this.reset();
      return;
    }

    try {
      // Re-initialize per render so diagram colors follow the current theme.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // HTML labels never embed images. Image-shape metadata is checked
        // separately before draw, where Mermaid starts its image requests.
        dompurifyConfig: {
          FORBID_TAGS: ["img", "style"],
          FORBID_ATTR: ["style"],
        },
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "default",
      });
      const remote = await hasRemoteMermaidImages(text, document.baseURI);
      if (seq !== this.renderSeq) return;
      if (remote && !remoteImagesAllowed()) {
        throw new Error("Remote images are disabled. Use View → Remote Images to render this diagram.");
      }
      // Mermaid sanitizes its SVG output (DOMPurify, securityLevel "strict").
      // Pass this view's element as the render container: with no container,
      // mermaid appends a temporary render div to <body>, which is a flex
      // column — the extra in-flow child redistributes the layout for the
      // frames the async render takes, visibly jolting the page (the
      // theme-switch statusbar flicker). A container keeps the temp element
      // out of the body's flow.
      // WebKit measures HTML labels at zero height under display:none.
      // Keep the pane measurable without painting Mermaid's temporary DOM.
      this.diagramEl.style.visibility = "hidden";
      this.diagramEl.hidden = false;
      const { svg } = await mermaid.render(
        `marky-mermaid-${nextMermaidId++}`,
        text,
        this.diagramEl,
      );
      if (seq !== this.renderSeq) return; // a newer render superseded us
      this.diagramEl.replaceChildren(parseSanitizedMermaidSvg(svg));
      this.diagramEl.hidden = false;
      this.errorEl.hidden = true;
      this.applySvgSize();
    } catch (err) {
      if (seq !== this.renderSeq) return;
      this.errorEl.textContent =
        err instanceof Error ? err.message : String(err);
      this.errorEl.hidden = false;
      this.diagramEl.hidden = true;
    } finally {
      this.diagramEl.style.removeProperty("visibility");
    }
  }

  private reset() {
    this.diagramEl.replaceChildren();
    this.diagramEl.hidden = true;
    this.errorEl.hidden = true;
  }
}

export const mermaidPlugin = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          code_block: (node) => new MermaidBlockView(node),
        },
      },
    }),
);
