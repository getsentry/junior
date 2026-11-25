import { useLocalStorage } from "@uidotdev/usehooks";

const LIVE_MARKDOWN_STORAGE_KEY = "junior:composer:live-markdown";

/**
 * Edit the browser-only choice to style Markdown in the message composer as
 * it is typed. On by default.
 */
export function useComposerLiveMarkdown() {
  return useLocalStorage<boolean>(LIVE_MARKDOWN_STORAGE_KEY, true);
}
