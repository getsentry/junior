import { expect, type Locator } from "@playwright/test";
import { waitForRender } from "../harness";

/**
 * Scroll a paged list to its end until `target` shows. Each step scrolls,
 * then waits for more rows or for `target`, so it moves on only after the
 * list loads or shows the rows that the last step asked for.
 */
export async function scrollListUntil(
  scrollToEnd: () => Promise<void>,
  rows: Locator,
  target: Locator,
): Promise<void> {
  while (!(await target.isVisible())) {
    const shown = await rows.count();
    await scrollToEnd();
    await expect
      .poll(
        async () => (await target.isVisible()) || (await rows.count()) > shown,
      )
      .toBe(true);
  }
}

/**
 * Scroll a transcript until `row` mounts. Rows mount only near the viewport,
 * so `up` moves one viewport at a time and does not skip past them. `down`
 * goes to the end. At an edge, it waits for a page to load past it.
 */
export async function scrollTranscriptUntil(
  transcript: Locator,
  row: Locator,
  direction: "down" | "up",
): Promise<void> {
  while ((await row.count()) === 0) {
    const step = await transcript.evaluate((element, direction) => {
      const { scrollHeight, scrollTop } = element;
      if (direction === "down") element.scrollTop = scrollHeight;
      else element.scrollTop -= element.clientHeight;
      return { moved: element.scrollTop !== scrollTop, scrollHeight };
    }, direction);
    if (step.moved) {
      await waitForRender(transcript.page());
      continue;
    }
    await expect
      .poll(
        async () =>
          (await row.count()) > 0 ||
          (await transcript.evaluate((element) => element.scrollHeight)) !==
            step.scrollHeight,
      )
      .toBe(true);
  }
}
