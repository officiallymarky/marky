/** Rows × columns dialog behind the native Insert ▸ Table… menu item. */

export interface TableDimensions {
  rows: number;
  cols: number;
}

interface TableElements {
  dialog: HTMLDialogElement;
  form: HTMLFormElement;
  rows: HTMLInputElement;
  cols: HTMLInputElement;
}

const MIN = 1;
const MAX_ROWS = 20;
const MAX_COLS = 10;

function buildDialogDom(): TableElements {
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
  document.body.append(dialog);
  const form = dialog.querySelector("form")!;
  return {
    dialog,
    form,
    rows: form.elements.namedItem("rows") as HTMLInputElement,
    cols: form.elements.namedItem("cols") as HTMLInputElement,
  };
}

let activeRequest: Promise<TableDimensions | null> | null = null;
let currentResolve: ((value: TableDimensions | null) => void) | null = null;
let currentFocusRestore: (() => void) | null = null;

const clamp = (value: number, max: number): number =>
  Math.min(Math.max(Math.round(value), MIN), max);

const parseDimension = (input: HTMLInputElement, max: number): number => {
  const parsed = Number(input.value);
  return Number.isFinite(parsed) ? clamp(parsed, max) : 3;
};

/**
 * Shows the table dialog. Resolves the entered dimensions, or null when
 * cancelled. The first row of the inserted table is a header row.
 */
export function openTableDialog(): Promise<TableDimensions | null> {
  // A repeat trigger while the dialog is open must not call showModal twice.
  // A pending request whose dialog is gone must heal instead of wedging.
  const existing = document.getElementById(
    "insert-table",
  ) as HTMLDialogElement | null;
  if (activeRequest && existing?.open) return activeRequest;
  const { promise, resolve } = Promise.withResolvers<TableDimensions | null>();
  activeRequest = promise;

  let dialog = existing;
  if (!dialog) {
    const elements = buildDialogDom();
    dialog = elements.dialog;
    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      elements.dialog.close("insert");
    });
    dialog
      .querySelector<HTMLButtonElement>("button[value=cancel]")!
      .addEventListener("click", () => elements.dialog.close("cancel"));
    dialog.addEventListener("close", () => {
      const dimensions =
        dialog!.returnValue !== "insert"
          ? null
          : {
              rows: parseDimension(elements.rows, MAX_ROWS),
              cols: parseDimension(elements.cols, MAX_COLS),
            };
      const resolveRequest = currentResolve;
      const restore = currentFocusRestore;
      currentResolve = null;
      currentFocusRestore = null;
      restore?.();
      resolveRequest?.(dimensions);
    });
  }

  // Escape leaves returnValue unchanged; reset so a cancel cannot inherit
  // "insert" from a previous use of the reused dialog.
  const previousFocus = document.activeElement;
  currentFocusRestore = () => (previousFocus as HTMLElement | null)?.focus();
  currentResolve = resolve;
  dialog.returnValue = "";
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>("input[name=rows]")!.focus();
  dialog.querySelector<HTMLInputElement>("input[name=rows]")!.select();
  return promise;
}
