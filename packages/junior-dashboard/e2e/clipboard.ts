import type { Page } from "@playwright/test";

/** Read the text that the page last copied to the clipboard. */
export function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
