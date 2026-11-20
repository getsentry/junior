const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

type ShortcutOptions = {
  /** Also hold Option on Apple, or Alt elsewhere. */
  alt?: boolean;
};

/** Shortcut text for `key` with this platform's modifier, such as `⌘K`. */
export function platformShortcut(
  key: string,
  options: ShortcutOptions = {},
): string {
  const letter = key.toUpperCase();
  if (isApple) return `${options.alt ? "⌥" : ""}⌘${letter}`;
  return `Ctrl ${options.alt ? "Alt " : ""}${letter}`;
}

/**
 * True when `event` is `key` with only this platform's modifier, and Option
 * or Alt when `alt` is set. Ctrl on Apple does not count: text fields use it
 * for bindings such as kill-line.
 */
export function isPlatformShortcut(
  event: KeyboardEvent,
  key: string,
  options: ShortcutOptions = {},
): boolean {
  const alt = options.alt ?? false;
  // Option changes the typed character on Apple layouts (⌥B types ∫), so a
  // letter with Option matches its physical key.
  const matches =
    alt && /^[a-z]$/.test(key)
      ? event.code === `Key${key.toUpperCase()}`
      : event.key.toLowerCase() === key;
  return (
    matches &&
    (isApple ? event.metaKey : event.ctrlKey) &&
    event.altKey === alt &&
    !event.shiftKey
  );
}
