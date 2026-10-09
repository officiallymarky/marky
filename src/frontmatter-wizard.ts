import { parseScalar } from "./frontmatter.ts";
import { createModal } from "./modal-dialog.ts";

export interface FrontMatterFields {
  /** Document title; empty string omits the `title` key. */
  title: string;
  /** ISO date (YYYY-MM-DD) or null to omit the `date` key. */
  date: string | null;
  tags: string[];
  aliases: string[];
  /** Document status; empty string omits the `status` key. */
  status: string;
}

/** Keys the dialog reads and updates; everything else is preserved as-is. */
const KNOWN_KEYS = ["title", "date", "tags", "aliases", "status"] as const;

/**
 * YAML scalar for one-line values: plain when it round-trips safely,
 * otherwise a double-quoted scalar (JSON escaping, which is valid YAML).
 */
function scalar(value: string): string {
  const trimmed = value.trim();
  const plainUnsafe =
    !trimmed ||
    /^(?:[-?:,[\]{}#&*!|>'"%@`])/.test(trimmed) ||
    /[:]|[#]/.test(trimmed) ||
    /^(?:~|null|true|false)$/i.test(trimmed) ||
    /^[+-]?(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+)$/.test(trimmed) ||
    /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d[\d_]*)?$/.test(
      trimmed,
    );
  return plainUnsafe ? JSON.stringify(trimmed) : trimmed;
}

function flowList(items: string[]): string {
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

/** Builds the byte-exact front-matter block for the dialog's fields. */
export function buildFrontMatterBlock(fields: FrontMatterFields): string {
  const lines = ["---"];
  const title = fields.title.trim();
  if (title) lines.push(`title: ${scalar(title)}`);
  if (fields.date) lines.push(`date: ${scalar(fields.date)}`);
  if (fields.tags.length) lines.push(`tags: ${flowList(fields.tags)}`);
  if (fields.aliases.length) lines.push(`aliases: ${flowList(fields.aliases)}`);
  const status = fields.status.trim();
  if (status) lines.push(`status: ${scalar(status)}`);
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

/** Local today as YYYY-MM-DD (the "sv" locale renders exactly that shape). */
export function todayIsoDate(): string {
  return new Date().toLocaleDateString("sv");
}

/** Reads plain strings and JSON-quoted strings; other YAML list syntax is unsupported. */
function parseFlowList(value: string): string[] | null {
  const match = /^\[(.*)]$/.exec(value.trim());
  if (!match) return null;
  const items: string[] = [];
  const inner = match[1];
  let index = 0;
  while (index < inner.length) {
    while (inner[index] === " " || inner[index] === "\t") index += 1;
    if (index === inner.length) break;
    if (inner[index] === '"') {
      let end = -1;
      for (let cursor = index + 1; cursor < inner.length; cursor += 1) {
        if (inner[cursor] === "\\") {
          cursor += 1;
        } else if (inner[cursor] === '"') {
          end = cursor;
          break;
        }
      }
      if (end < 0) return null;
      try {
        items.push(JSON.parse(inner.slice(index, end + 1)) as string);
      } catch {
        return null;
      }
      index = end + 1;
    } else {
      const comma = inner.indexOf(",", index);
      const raw = (comma < 0 ? inner.slice(index) : inner.slice(index, comma)).trim();
      // Never reinterpret YAML collections, quoted values or typed scalars
      // as plain strings when the dialog regenerates the list.
      if (
        !raw ||
        raw.startsWith("'") ||
        /[[\]{}:#]/.test(raw) ||
        parseScalar(raw) !== raw
      ) return null;
      items.push(raw);
      index = comma < 0 ? inner.length : comma;
    }
    while (inner[index] === " " || inner[index] === "\t") index += 1;
    if (index < inner.length) {
      if (inner[index] !== ",") return null;
      index += 1;
    }
  }
  return items;
}

interface KeyPresence {
  /** Line index of a single-line `key:` entry, or -1 when absent. */
  line: number;
  /** True when the key has a value the dialog cannot rewrite safely. */
  complex: boolean;
}

function keyLine(lines: string[], key: string): KeyPresence {
  const pattern = new RegExp(
    `^(?:${key}|'${key}'|"${key}")[ \\t]*:(.*)$`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index].replace(/\r$/, ""));
    if (!match) continue;
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("|") || raw.startsWith(">")) {
      let next = index + 1;
      while (next < lines.length && /^(?:[ \t]*|[ \t]*#.*)\r?$/.test(lines[next])) next += 1;
      const nested = /^[ \t]|^-(?:[ \t]|\r?$)/.test(lines[next] ?? "");
      return { line: nested ? -2 : index, complex: nested };
    }
    return { line: index, complex: false };
  }
  return { line: -1, complex: false };
}

export interface ReadFrontMatter {
  prefill: FrontMatterFields;
  /** False when a known value uses YAML syntax the dialog cannot rewrite safely. */
  supported: boolean;
}

/** Reads the dialog's fields from an existing front-matter block. */
export function readKnownFields(front: string): ReadFrontMatter {
  const lines = front.split("\n");
  let supported = true;
  const read = (key: string): string => {
    const presence = keyLine(lines, key);
    if (presence.complex) supported = false;
    if (presence.line < 0) return "";
    const value = lines[presence.line].replace(/^(?:[^:]*):/, "").trim();
    if (!value || value.startsWith("#")) return "";
    const parsed = parseScalar(value);
    // A nonempty value the reader cannot turn into a plain string — anchors,
    // tags, flow collections, quoted empties — would be dropped by the
    // rewrite, so it blocks the dialog instead.
    if (parsed === null) supported = false;
    return parsed ?? "";
  };
  const readList = (key: string): string[] => {
    const presence = keyLine(lines, key);
    if (presence.complex) supported = false;
    if (presence.line < 0) return [];
    const value = lines[presence.line].replace(/^(?:[^:]*):/, "").trim();
    if (!value || value.startsWith("#")) return [];
    const items = parseFlowList(value);
    if (items === null) supported = false;
    return items ?? [];
  };
  // Build prefill first: the reads set `supported`, and an object literal
  // would capture `supported` before its own property reads ran.
  const prefill: FrontMatterFields = {
    title: read("title"),
    date: read("date") || null,
    tags: readList("tags"),
    aliases: readList("aliases"),
    status: read("status"),
  };
  return { supported, prefill };
}

/**
 * Rewrites the known keys of an existing front-matter block in place,
 * preserving every other line byte-exact. Returns null when a known value
 * uses YAML syntax the dialog cannot rewrite safely.
 */
export function updateFrontMatterBlock(
  front: string,
  fields: FrontMatterFields,
): string | null {
  if (!readKnownFields(front).supported) return null;
  const lines = front.split("\n");
  const crlf = lines.map((line) => line.endsWith("\r"));
  const closeIndexOf = () => {
    for (let index = lines.length - 1; index > 0; index -= 1) {
      if (lines[index].replace(/\r$/, "") === "---") return index;
    }
    return -1;
  };
  if (closeIndexOf() < 0) return null;

  for (const key of KNOWN_KEYS) {
    const presence = keyLine(lines, key);
    if (presence.complex) return null;
    const value =
      key === "title"
        ? fields.title.trim()
        : key === "date"
          ? (fields.date ?? "")
          : key === "status"
            ? fields.status.trim()
            : "";
    const list = key === "tags" ? fields.tags : key === "aliases" ? fields.aliases : [];
    const rendered = list.length
      ? `${key}: ${flowList(list)}`
      : value
        ? `${key}: ${scalar(value)}`
        : "";
    if (presence.line >= 0) {
      if (rendered) {
        lines[presence.line] = rendered + (crlf[presence.line] ? "\r" : "");
      } else {
        lines.splice(presence.line, 1);
        crlf.splice(presence.line, 1);
      }
    } else if (rendered) {
      // Re-locate the closing fence: earlier splices shift indices.
      const closeIndex = closeIndexOf();
      lines.splice(closeIndex, 0, rendered + (crlf[closeIndex] ? "\r" : ""));
      crlf.splice(closeIndex, 0, false);
    }
  }
  return lines.join("\n");
}

interface WizardElements {
  title: HTMLInputElement;
  includeDate: HTMLInputElement;
  date: HTMLInputElement;
  tags: HTMLInputElement;
  aliases: HTMLInputElement;
  status: HTMLInputElement;
  primary: HTMLButtonElement;
}

function buildWizardDom(): {
  dialog: HTMLDialogElement;
  fields: WizardElements;
} {
  const dialog = document.createElement("dialog");
  dialog.id = "frontmatter-wizard";
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Front matter</h2>
      <label>
        <span>Title</span>
        <input name="title" type="text" placeholder="Document title" />
      </label>
      <div class="wizard-row">
        <label class="wizard-check">
          <input name="includeDate" type="checkbox" checked />
          <span>Date</span>
        </label>
        <input name="date" type="date" />
      </div>
      <label>
        <span>Tags (comma separated)</span>
        <input name="tags" type="text" placeholder="notes, project" />
      </label>
      <label>
        <span>Aliases (comma separated)</span>
        <input name="aliases" type="text" placeholder="alternative names" />
      </label>
      <label>
        <span>Status</span>
        <input name="status" type="text" placeholder="draft, published, …" />
      </label>
      <menu>
        <li><button type="button" value="cancel">Cancel</button></li>
        <li><button type="submit" value="insert" class="primary">Insert</button></li>
      </menu>
    </form>
  `;
  const form = dialog.querySelector("form")!;
  return {
    dialog,
    fields: {
      title: form.elements.namedItem("title") as HTMLInputElement,
      includeDate: form.elements.namedItem("includeDate") as HTMLInputElement,
      date: form.elements.namedItem("date") as HTMLInputElement,
      tags: form.elements.namedItem("tags") as HTMLInputElement,
      aliases: form.elements.namedItem("aliases") as HTMLInputElement,
      status: form.elements.namedItem("status") as HTMLInputElement,
      primary: dialog.querySelector<HTMLButtonElement>("button.primary")!,
    },
  };
}

/**
 * Renders a list into the dialog's comma-separated field. Items that a plain
 * split would not survive — commas, quotes, surrounding whitespace, empties —
 * are JSON-quoted so `parseListInput` reads them back exactly.
 */
export function formatListInput(items: string[]): string {
  return items
    .map((item) => (!item || /[",]|^\s|\s$/.test(item) ? JSON.stringify(item) : item))
    .join(", ");
}

/**
 * Reads the dialog's comma-separated field. Quoted items keep their commas,
 * quotes and whitespace; unquoted segments are trimmed and empty ones dropped.
 * Malformed quoting is taken literally rather than losing the text.
 */
export function parseListInput(value: string): string[] {
  const items: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === " " || value[index] === "\t")) {
      index += 1;
    }
    if (index >= value.length) break;
    if (value[index] === '"') {
      let end = index + 1;
      while (end < value.length && value[end] !== '"') {
        end += value[end] === "\\" ? 2 : 1;
      }
      const literal = value.slice(index, Math.min(end + 1, value.length));
      try {
        const parsed: unknown = JSON.parse(literal);
        if (typeof parsed === "string") {
          items.push(parsed);
          index = end + 1;
          continue;
        }
      } catch {
        // Not a JSON string: keep the text as written.
      }
      items.push(literal.trim());
      index += literal.length;
      continue;
    }
    const comma = value.indexOf(",", index);
    const plain = value.slice(index, comma < 0 ? value.length : comma).trim();
    if (plain) items.push(plain);
    index = (comma < 0 ? value.length : comma) + 1;
  }
  return items;
}

const open = createModal<FrontMatterFields, WizardElements>(() => {
  const { dialog, fields } = buildWizardDom();
  return {
    dialog,
    elements: fields,
    readValue: () => ({
      title: fields.title.value,
      date: fields.includeDate.checked ? fields.date.value : null,
      tags: parseListInput(fields.tags.value),
      aliases: parseListInput(fields.aliases.value),
      status: fields.status.value,
    }),
  };
});

/**
 * Shows the front-matter dialog. Resolves the entered fields, or null when
 * cancelled; `submitLabel` switches the button for edit mode.
 */
export function openFrontMatterWizard(
  defaults: Partial<FrontMatterFields> = {},
  options: { submitLabel?: string } = {},
): Promise<FrontMatterFields | null> {
  return open((fields) => {
    fields.title.value = defaults.title ?? "";
    fields.includeDate.checked = defaults.date != null;
    fields.date.value = defaults.date ?? todayIsoDate();
    fields.tags.value = formatListInput(defaults.tags ?? []);
    fields.aliases.value = formatListInput(defaults.aliases ?? []);
    fields.status.value = defaults.status ?? "";
    fields.primary.textContent = options.submitLabel ?? "Insert";
  });
}
