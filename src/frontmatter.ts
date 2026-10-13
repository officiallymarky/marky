interface SplitDocument {
  /** A byte-order mark the file starts with, or "" when it has none. */
  bom: string;
  /** Verbatim front-matter block including delimiters and trailing newline. */
  front: string | null;
  /** Markdown body without the front-matter block or the byte-order mark. */
  body: string;
}

/**
 * Splits a leading YAML front-matter block (`---` … `---`) off the document.
 * The block is kept byte-exact so YAML is never reformatted, and it may be
 * empty: `---` immediately followed by the closing fence. A byte-order mark is
 * neither front matter nor body, so it is reported on its own: the editor
 * never sees it, and a save can put it back. Both fences may carry trailing
 * spaces.
 */
export function splitFrontmatter(md: string): SplitDocument {
  const bom = md.startsWith("\uFEFF") ? "\uFEFF" : "";
  const rest = bom ? md.slice(bom.length) : md;
  const match = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!match) return { bom, front: null, body: rest };
  return { bom, front: match[0], body: rest.slice(match[0].length) };
}

/** Rejoins a document: byte-order mark, front-matter block, markdown body. */
export function combineFrontmatter(
  bom: string,
  front: string | null,
  body: string,
): string {
  const block = !front ? "" : front.endsWith("\n") ? front : `${front}\n`;
  return `${bom}${block}${body}`;
}

/**
 * True for scalars YAML reads as a number (`0x2A`, `1e5`, `.inf`). The reader
 * and the front-matter writer must agree on this, or the writer emits a value
 * its own reader then refuses.
 */
export function isYamlNumber(value: string): boolean {
  return (
    /^[+-]?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/i.test(value) ||
    /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d[\d_]*)?$/i.test(value) ||
    /^[+-]?\.(?:inf|nan)$/i.test(value)
  );
}

// Only common one-line string scalars are supported; other YAML forms fall back.
export function parseScalar(raw: string): string | null {
  const value = raw.trimStart();
  if (value.startsWith('"')) {
    let end = -1;
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === "\\") {
        index += 1;
      } else if (value[index] === '"') {
        end = index;
        break;
      }
    }
    if (end < 0) return null;
    const trailing = value.slice(end + 1).trim();
    if (trailing && !trailing.startsWith("#")) return null;
    try {
      const title: unknown = JSON.parse(value.slice(0, end + 1));
      return typeof title === "string" && title.trim() ? title.trim() : null;
    } catch {
      return null;
    }
  }

  if (value.startsWith("'")) {
    let title = "";
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== "'") {
        title += value[index];
        continue;
      }
      if (value[index + 1] === "'") {
        title += "'";
        index += 1;
        continue;
      }
      const trailing = value.slice(index + 1).trim();
      if (trailing && !trailing.startsWith("#")) return null;
      return title.trim() || null;
    }
    return null;
  }

  const comment = value.search(/(?:^|[ \t]+)#/);
  const title = (comment < 0 ? value : value.slice(0, comment)).trim();
  if (!title || /^(?:\[|\]|\{|\}|[|>!&*])/.test(title)) return null;
  if (/^(?:~|null|true|false)$/i.test(title)) return null;
  if (isYamlNumber(title)) return null;
  return title;
}

/** Returns a simple top-level YAML title, or the file name if none is usable. */
export function getDocumentTitle(
  frontmatter: string | null,
  fallbackName: string,
): string {
  if (!frontmatter) return fallbackName;
  // Tolerate a byte-order mark and trailing spaces on the fences: the split
  // hands the block over verbatim, so the reader must accept what it produced.
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?$/.exec(frontmatter);
  if (!match) return fallbackName;

  const titleMatch = /^(?:title|'title'|"title")[ \t]*:[ \t]*([^\r\n]*)$/m.exec(match[1]);
  if (!titleMatch) return fallbackName;
  return parseScalar(titleMatch[1]) ?? fallbackName;
}
