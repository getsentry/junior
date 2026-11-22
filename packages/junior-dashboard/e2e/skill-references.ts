import type { Page } from "@playwright/test";

// The `::highlight()` name that paints skill references in the composer.
const LINK_HIGHLIGHT = "skill-reference";

/**
 * The text of each skill reference that the composer styles as a link. A
 * CSS highlight paints them, so they have no element to find by role.
 */
export async function styledSkillReferences(page: Page): Promise<string[]> {
  return page.evaluate((name) => {
    const highlight = CSS.highlights.get(name);
    return highlight ? [...highlight].map((range) => range.toString()) : [];
  }, LINK_HIGHLIGHT);
}

/**
 * Click the middle of the styled `$name` in the composer with the mouse,
 * as a person does. The reference is text in the editor, not an element.
 */
export async function clickSkillReference(
  page: Page,
  name: string,
): Promise<void> {
  const point = await page.evaluate(
    ({ highlightName, text }) => {
      const highlight = CSS.highlights.get(highlightName);
      const range = [...(highlight ?? [])].find(
        (candidate): candidate is Range =>
          candidate instanceof Range && candidate.toString() === text,
      );
      const rect = range?.getClientRects()[0];
      return (
        rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      );
    },
    { highlightName: LINK_HIGHLIGHT, text: `$${name}` },
  );
  if (!point) throw new Error(`No styled $${name} in the composer`);
  await page.mouse.click(point.x, point.y);
}
