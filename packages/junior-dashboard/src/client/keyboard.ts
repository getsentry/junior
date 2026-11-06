const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Shortcut text for `key` with this platform's modifier, such as `⌘K`. */
export function platformShortcut(key: string): string {
  return isApple ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}

/**
 * True when `event` is `key` with only this platform's modifier. Ctrl on Apple
 * does not count: text fields use it for bindings such as kill-line.
 */
export function isPlatformShortcut(event: KeyboardEvent, key: string): boolean {
  return (
    event.key.toLowerCase() === key &&
    (isApple ? event.metaKey : event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}
