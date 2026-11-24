import type { Locator, Page } from "@playwright/test";

type MenuWindow = typeof window & { menuCancelled?: boolean };

/**
 * Right-click `target` and read whether the page cancelled the event. A
 * cancelled right-click hides the browser's own menu, which a test cannot
 * see. Needs real timers: the read waits for the event to finish.
 */
export async function rightClickCancelled(target: Locator): Promise<boolean> {
  const page = target.page();
  await page.evaluate(() => {
    const menuWindow = window as MenuWindow;
    delete menuWindow.menuCancelled;
    window.addEventListener(
      "contextmenu",
      (event) => {
        // Read after every listener ran, also ones that stop the event.
        setTimeout(() => {
          menuWindow.menuCancelled = event.defaultPrevented;
        });
      },
      { capture: true, once: true },
    );
  });
  await target.click({ button: "right" });
  await page.waitForFunction(() => "menuCancelled" in window);
  return page.evaluate(() => Boolean((window as MenuWindow).menuCancelled));
}

/**
 * Put one finger down on `target` at `position` and keep it there, as a
 * long press does. Returns the lift. Playwright has no long press, so this
 * sends the touch through Chrome's input events.
 */
export async function holdTouch(
  page: Page,
  target: Locator,
  position: { x: number; y: number },
): Promise<() => Promise<void>> {
  // The mouse lands where the finger will.
  await page.evaluate(() => {
    delete document.documentElement.dataset["touchPoint"];
    window.addEventListener(
      "mousemove",
      (event) => {
        document.documentElement.dataset["touchPoint"] =
          `${event.clientX},${event.clientY}`;
      },
      { once: true },
    );
  });
  await target.hover({ position });
  const point = await page.waitForFunction(
    () => document.documentElement.dataset["touchPoint"],
  );
  const [x, y] = (await point.jsonValue()).split(",").map(Number);
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    touchPoints: [{ id: 1, x, y }],
    type: "touchStart",
  });
  return async () => {
    await touch.send("Input.dispatchTouchEvent", {
      touchPoints: [],
      type: "touchEnd",
    });
    await touch.detach();
  };
}
