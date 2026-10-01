/**
 * Writing-font options for the rich editor. Raw mode stays a fixed
 * monospace source view, and code/inline-code keep their own mono stack.
 * Sizes live in styles.css keyed by `data-font-size`.
 */
export type FontId = "system" | "serif" | "mono";
export type FontSizeId = "small" | "medium" | "large";

export interface FontFamilyOption {
  id: FontId;
  label: string;
}

export interface FontSizeOption {
  id: FontSizeId;
  label: string;
}

export const FONT_FAMILIES: readonly FontFamilyOption[] = [
  { id: "system", label: "System Sans" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Monospace" },
];

export const FONT_SIZES: readonly FontSizeOption[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

export const DEFAULT_FONT: FontId = "system";
export const DEFAULT_FONT_SIZE: FontSizeId = "medium";

/** A stored value wins when it names an option; anything else keeps the default. */
export function resolveFont(stored: string | null): FontId {
  return FONT_FAMILIES.some((font) => font.id === stored)
    ? (stored as FontId)
    : DEFAULT_FONT;
}

export function resolveFontSize(stored: string | null): FontSizeId {
  return FONT_SIZES.some((size) => size.id === stored)
    ? (stored as FontSizeId)
    : DEFAULT_FONT_SIZE;
}
