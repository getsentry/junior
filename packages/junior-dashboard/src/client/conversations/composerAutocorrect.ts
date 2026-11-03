import { useLocalStorage } from "@uidotdev/usehooks";

const AUTOCORRECT_STORAGE_KEY = "junior:composer:autocorrect";

/**
 * Edit the browser-only choice to let the keyboard autocorrect, spell check,
 * and capitalize the message composer. Off by default because these change
 * ids, paths, and code.
 */
export function useComposerAutocorrect() {
  return useLocalStorage<boolean>(AUTOCORRECT_STORAGE_KEY, false);
}
