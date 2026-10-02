/** Rows × columns dialog behind the native Insert ▸ Table… menu item. */
import { createModal } from "./modal-dialog.ts";

export interface TableDimensions {
  rows: number;
  cols: number;
}

const MIN = 1;
const MAX_ROWS = 20;
const MAX_COLS = 10;

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(Math.round(value), MIN), max);

const parseDimension = (input: HTMLInputElement, max: number): number => {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? clamp(parsed, max) : 3;
};

const open = createModal<TableDimensions, {
  rows: HTMLInputElement;
  cols: HTMLInputElement;
}>(() => {
  const dialog = document.createElement("dialog");
  dialog.id = "insert-table";
  dialog.innerHTML = `
    <form method="dialog">
      <h2>Insert table</h2>
      <label>
        <span>Rows (including header)</span>
        <input name="rows" type="number" min="${MIN}" max="${MAX_ROWS}" value="3" />
      </label>
      <label>
        <span>Columns</span>
        <input name="cols" type="number" min="${MIN}" max="${MAX_COLS}" value="3" />
      </label>
      <menu>
        <li><button type="button" value="cancel">Cancel</button></li>
        <li><button type="submit" value="insert" class="primary">Insert</button></li>
      </menu>
    </form>
  `;
  const form = dialog.querySelector("form")!;
  const rows = form.elements.namedItem("rows") as HTMLInputElement;
  const cols = form.elements.namedItem("cols") as HTMLInputElement;
  return {
    dialog,
    elements: { rows, cols },
    readValue: () => ({
      rows: parseDimension(rows, MAX_ROWS),
      cols: parseDimension(cols, MAX_COLS),
    }),
    onOpen: () => {
      rows.focus();
      rows.select();
    },
  };
});

/**
 * Shows the table dialog. Resolves the entered dimensions, or null when
 * cancelled. The first row of the inserted table is a header row.
 */
export function openTableDialog(): Promise<TableDimensions | null> {
  return open();
}
