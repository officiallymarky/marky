/** Built-in editor themes. Palettes live in styles.css keyed by `data-theme`. */
export type ThemeId =
  | "light"
  | "dark"
  | "sepia"
  | "solarized"
  | "nord"
  | "dracula";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  /** Dark-family themes keep the `html.dark` class (mermaid, dark-only CSS). */
  dark: boolean;
}

export const THEMES: readonly ThemeDefinition[] = [
  { id: "light", label: "Light", dark: false },
  { id: "sepia", label: "Sepia", dark: false },
  { id: "solarized", label: "Solarized Light", dark: false },
  { id: "dark", label: "Dark", dark: true },
  { id: "nord", label: "Nord", dark: true },
  { id: "dracula", label: "Dracula", dark: true },
];

/** Fired on `document` whenever the theme changes (e.g. mermaid re-renders). */
export const THEME_CHANGED_EVENT = "marky-theme-changed";

export function themeById(id: ThemeId): ThemeDefinition {
  const theme = THEMES.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`Unknown theme: ${id}`);
  return theme;
}

/**
 * A stored value wins when it names a theme (legacy values were exactly
 * "light"/"dark", so old storage keeps working); otherwise the OS preference
 * decides on first run.
 */
export function resolveTheme(
  stored: string | null,
  prefersDark: boolean,
): ThemeDefinition {
  return (
    THEMES.find((theme) => theme.id === stored) ??
    themeById(prefersDark ? "dark" : "light")
  );
}

export function nextTheme(current: ThemeId): ThemeDefinition {
  const index = THEMES.findIndex((theme) => theme.id === current);
  return THEMES[(index + 1) % THEMES.length];
}
