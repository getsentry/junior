import { expect, type Locator } from "@playwright/test";

/**
 * Pick an option from a list that closes on a pick, such as a select, a
 * search, or the command palette, and wait for the list to close. The list
 * closes with a transition, and a press on another control before it ends
 * can be lost.
 */
export async function pickOption(option: Locator): Promise<void> {
  await option.click();
  await expect(option).toBeHidden();
}
