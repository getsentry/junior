import type { Page } from "@playwright/test";

/**
 * Paste text into the focused element with the paste shortcut, the way a
 * person does. The editor reads the caret from the page on the shortcut's
 * key press. A `paste` event sent from a script has no key press, so the
 * editor pastes at the caret it last saw, which can be from before the
 * last arrow key.
 */
export async function pasteText(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("ControlOrMeta+V");
}
