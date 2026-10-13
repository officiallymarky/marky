type MenuOption = string | { id: string };

/**
 * The option a native menu id names after `prefix` (`theme-nord` names the
 * `nord` theme). Undefined when the id has another prefix or names no option,
 * so overlapping prefixes (`font-` and `font-size-`) cannot claim each other.
 */
export function menuOption<T extends MenuOption>(
  action: string,
  prefix: string,
  options: readonly T[],
): T | undefined {
  if (!action.startsWith(prefix)) return undefined;
  const id = action.slice(prefix.length);
  return options.find((option) => (typeof option === "string" ? option : option.id) === id);
}
