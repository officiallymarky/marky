import { convertFileSrc } from "@tauri-apps/api/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** Must match `local_image::SCHEME` in the Rust shell. */
const IMAGE_SCHEME = "marky-image";
const REMOTE_KEY = "images.remote";
const CHANGED_EVENT = "marky-images-changed";

/** Where an image's `src` points once resolved against its document. */
export type ImageSource =
  | { kind: "file"; path: string }
  | { kind: "remote"; url: string }
  | { kind: "inline"; url: string }
  | { kind: "none" };

/** A file URL for a filesystem path; `%`, `#` and `?` stay literal. */
function fileUrl(path: string): string {
  const slashed = path.replaceAll("\\", "/").replace(/[%#?]/g, encodeURIComponent);
  return `file://${slashed.startsWith("/") ? "" : "/"}${slashed}`;
}

function filePath(url: URL): string | null {
  // A host names a network share, not a local file.
  if (url.host) return null;
  try {
    const path = decodeURIComponent(url.pathname);
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * Resolves an image `src` the way a Markdown viewer does: a relative path
 * against the document's folder, an absolute path or `file:` URL as itself.
 * A relative path in an unsaved document has no folder to resolve against.
 */
export function imageSource(src: string, documentPath: string | null): ImageSource {
  const reference = src.trim().replaceAll("\\", "/");
  if (!reference) return { kind: "none" };
  if (/^(data|blob):/i.test(reference)) return { kind: "inline", url: reference };
  if (/^(https?:)?\/\//i.test(reference)) return { kind: "remote", url: reference };
  const drive = /^[a-z]:\//i.test(reference);
  const file = /^file:/i.test(reference);
  if (!drive && !file && /^[a-z][a-z0-9+.-]*:/i.test(reference)) return { kind: "none" };
  if (!drive && !file && !reference.startsWith("/") && !documentPath) return { kind: "none" };
  try {
    const url = new URL(drive ? `/${reference}` : reference, fileUrl(documentPath ?? "/"));
    const path = filePath(url);
    return path ? { kind: "file", path } : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

let documentPath: string | null = null;

const refreshImages = () => document.dispatchEvent(new Event(CHANGED_EVENT));

/** Remote images reveal the reader to their host, so they load only on request. */
export function remoteImagesAllowed(): boolean {
  return localStorage.getItem(REMOTE_KEY) === "1";
}

export function setRemoteImagesAllowed(allowed: boolean): void {
  localStorage.setItem(REMOTE_KEY, allowed ? "1" : "0");
  refreshImages();
}

/** The file relative images resolve against; a Save As moves them with it. */
export function setImageDocument(path: string | null): void {
  if (path === documentPath) return;
  documentPath = path;
  refreshImages();
}

/** Node view for `image`: loads local files through the image protocol. */
class ImageView {
  dom: HTMLElement;
  private node: ProseNode;
  private image: HTMLImageElement;
  private placeholder: HTMLElement;
  private render = () => {
    const { src, alt, title } = this.node.attrs as Record<"src" | "alt" | "title", string>;
    const source = imageSource(src, documentPath);
    const blocked = source.kind === "remote" && !remoteImagesAllowed();
    const url =
      source.kind === "file"
        ? convertFileSrc(source.path, IMAGE_SCHEME)
        : source.kind === "none" || blocked
          ? ""
          : source.url;
    this.image.alt = alt;
    this.image.title = title;
    this.image.hidden = blocked;
    if (!url) this.image.removeAttribute("src");
    else if (this.image.getAttribute("src") !== url) this.image.src = url;
    this.placeholder.hidden = !blocked;
    this.placeholder.textContent = alt || "Remote image";
    this.placeholder.title = blocked
      ? `Not loaded: ${src}\nView → Remote Images loads images from the web.`
      : "";
  };

  constructor(node: ProseNode) {
    this.node = node;
    this.dom = document.createElement("span");
    this.dom.className = "md-image";
    this.image = document.createElement("img");
    this.placeholder = document.createElement("span");
    this.placeholder.className = "md-image-blocked";
    this.dom.append(this.image, this.placeholder);
    document.addEventListener(CHANGED_EVENT, this.render);
    this.render();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  destroy(): void {
    document.removeEventListener(CHANGED_EVENT, this.render);
  }
}

export const imagePlugin = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          image: (node) => new ImageView(node),
        },
      },
    }),
);
