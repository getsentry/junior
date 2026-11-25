import { expect, type Locator } from "@playwright/test";

/**
 * Wait until `scope` shows highlighted code. The highlighter runs after the
 * first render and replaces the plain block, which changes its height. The
 * highlighted block has no role or label of its own, so find it by class.
 */
export async function waitForHighlightedCode(scope: Locator): Promise<void> {
  await expect(scope.locator("pre.shiki").first()).toBeVisible();
}
