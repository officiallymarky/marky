export interface SplitDocument {
  /** Verbatim front-matter block including delimiters and trailing newline. */
  front: string | null;
  /** Markdown body without the front-matter block. */
  body: string;
}

/**
 * Splits a leading YAML front-matter block (`---` … `---`) off the document.
 * The block is kept byte-exact so YAML is never reformatted, and it may be
 * empty: `---` immediately followed by the closing fence.
 */
export function splitFrontmatter(md: string): SplitDocument {
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)??---(?:\r?\n|$)/.exec(md);
  if (!match) return { front: null, body: md };
  return { front: match[0], body: md.slice(match[0].length) };
}

/** Rejoins a front-matter block with a markdown body. */
export function combineFrontmatter(front: string | null, body: string): string {
  if (!front) return body;
  return front.endsWith("\n") ? front + body : `${front}\n${body}`;
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
  const isNumber =
    /^[+-]?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/i.test(title) ||
    /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d[\d_]*)?$/i.test(title) ||
    /^[+-]?\.(?:inf|nan)$/i.test(title);
  if (isNumber) return null;
  return title;
}

/** Returns a simple top-level YAML title, or the file name if none is usable. */
export function getDocumentTitle(
  frontmatter: string | null,
  fallbackName: string,
): string {
  if (!frontmatter) return fallbackName;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?$/.exec(frontmatter);
  if (!match) return fallbackName;

  const titleMatch = /^(?:title|'title'|"title")[ \t]*:[ \t]*([^\r\n]*)$/m.exec(match[1]);
  if (!titleMatch) return fallbackName;
  return parseScalar(titleMatch[1]) ?? fallbackName;
}
