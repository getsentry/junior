import { useSyncExternalStore } from "react";

/**
 * Make the hook that reads and updates one choice that this browser keeps.
 * `choices` lists the values other than `fallback`. `fallback` is saved as
 * no entry, and any other saved value reads as `fallback`, as do blocked
 * storage and a server render. A save sends `event` on the window, so
 * every reader in this tab and any other listener, such as the theme
 * script, see it. Other tabs see the `storage` event.
 */
export function browserChoice<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
  event = "junior:browser-choice",
) {
  function read(): T {
    try {
      const value = window.localStorage.getItem(key);
      return choices.find((choice) => choice === value) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function subscribe(onChange: () => void): () => void {
    window.addEventListener(event, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(event, onChange);
      window.removeEventListener("storage", onChange);
    };
  }
  function save(choice: T): void {
    try {
      if (choice === fallback) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, choice);
    } catch {
      // Storage is blocked, so the choice stays `fallback`.
      return;
    }
    window.dispatchEvent(new Event(event));
  }
  return (): [T, (choice: T) => void] => [
    useSyncExternalStore(subscribe, read, () => fallback),
    save,
  ];
}
