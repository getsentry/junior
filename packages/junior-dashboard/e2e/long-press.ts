import { expect, type Locator } from "@playwright/test";

/**
 * Hold a real touch on the middle of `target` until `opens` shows, then lift
 * it. Playwright has no long press, so this sends the touch through the
 * browser's input pipeline, as a finger does.
 */
export async function longPress(target: Locator, opens: Locator) {
  const page = target.page();
  const box = await target.boundingBox();
  if (!box) throw new Error("The long press target is not visible");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send("Input.dispatchTouchEvent", {
      touchPoints: [{ id: 1, ...point }],
      type: "touchStart",
    });
    await expect(opens).toBeVisible();
    await touch.send("Input.dispatchTouchEvent", {
      touchPoints: [],
      type: "touchEnd",
    });
  } finally {
    await touch.detach();
  }
}
