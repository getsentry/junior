import { expect, test } from "@playwright/test";
import {
  type DashboardE2eServer,
  mockDashboardApis,
  startDashboardE2eServer,
} from "./harness";

let server: DashboardE2eServer;

test.beforeAll(async () => {
  server = await startDashboardE2eServer();
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await mockDashboardApis(page);
});

/**
 * Focused composers must stay in the bottom of the visual viewport.
 * Hit-test near the bottom edge so a mid-screen/centered regression fails
 * without using banned bounding-box layout APIs.
 *
 * Sample in layout coordinates: shell top is offsetTop, height is visualHeight,
 * so the visible bottom is offsetTop + visualHeight.
 */
async function expectFocusedComposerAtVisualViewportBottom(
  composer: import("@playwright/test").Locator,
  visualHeightPx: number,
  offsetTopPx = 0,
) {
  await expect(composer).toBeFocused();
  await expect
    .poll(() =>
      composer.evaluate(
        (node, geometry) => {
          const form = node.closest("form");
          if (!(node instanceof HTMLElement) || !form) return "missing-form";
          if (document.activeElement !== node) return "not-focused";

          // Sample just above the bottom edge of the simulated visual viewport.
          const sampleY = geometry.offsetTopPx + geometry.heightPx - 12;
          const sampleX = Math.max(24, Math.floor(window.innerWidth / 2));
          const hit = document.elementFromPoint(sampleX, sampleY);
          if (!hit) return "no-hit";
          if (hit === node || form.contains(hit) || node.contains(hit)) {
            return "composer-at-bottom";
          }
          return "composer-not-at-bottom";
        },
        { heightPx: visualHeightPx, offsetTopPx },
      ),
    )
    .toBe("composer-at-bottom");
}

test("keeps the new conversation composer above the mobile keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(server.baseURL);
  await page.getByRole("button", { name: "New conversation" }).click();

  const heading = page.getByRole("heading", { name: "New conversation" });
  const composer = page.getByLabel("Start a conversation");
  await expect(heading).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  // Create mode must pin the composer outside the scroll body, same shell as
  // reply chats. Layout pixels belong to visual QA; this checks structure.
  await expect
    .poll(() =>
      composer.evaluate((node) => {
        const form = node.closest("form");
        if (!form) return "missing-form";
        let current: Element | null = form.parentElement;
        while (current) {
          const overflowY = getComputedStyle(current).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") {
            return "composer-in-scroll";
          }
          if (current.getAttribute("aria-label") === "Selected conversation") {
            break;
          }
          current = current.parentElement;
        }
        return "pinned-footer";
      }),
    )
    .toBe("pinned-footer");

  const shell = page.locator("main").first();
  // First focus often opens the keyboard with a non-zero visual offset. Dock to
  // that rectangle so the input stays on the visible bottom, not mid-screen.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 140 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe("520px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 140);
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.route("**/api/conversations/*/messages", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "slack:CQA123:1770003600.000200",
        messageId: "mobile-message",
        status: "accepted",
      },
    });
  });
  await page.goto(`${server.baseURL}/conversations`);
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
  });
  await expect(navigationTrigger).toBeVisible();
  await expect(page.getByLabel("Junior home")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open profile menu for Dashboard User" }),
  ).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Conversations", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Archive Investigate checkout latency" }),
  ).toBeVisible();
  await navigationTrigger.click();
  await expect(page.getByText(/^junior version /)).toBeVisible();
  const navigationSheet = page.getByRole("dialog", { name: "Navigation" });
  const spendCallout = navigationSheet.getByLabel(
    "Personal model spend: 7 days $0.07, 30 days $0.07",
    { exact: true },
  );
  await expect(spendCallout).toBeVisible();
  await expect(spendCallout.getByText("7d $0.07")).toBeVisible();
  await expect(spendCallout.getByText("30d $0.07")).toBeVisible();
  // Spend sits above every destination, including primary nav.
  const spendAbovePrimary = await spendCallout.evaluate((node) => {
    const dialog = node.closest('[role="dialog"]');
    const primary = dialog?.querySelector('nav[aria-label="Primary"]');
    if (!dialog || !primary) return false;
    return Boolean(
      node.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(spendAbovePrimary).toBe(true);
  await expect(
    page.getByLabel("Account menu for Dashboard User"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Signed in as Dashboard User"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "My profile" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "API tokens" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  const closeNavigation = page.getByRole("button", {
    name: "Close navigation",
  });
  await expect(closeNavigation).toBeVisible();
  await closeNavigation.click();
  // Compact mobile composer needs a participant fixture.
  await page
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(page).toHaveURL(
    `${server.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
  );
  // One shell row: back + title + overflow. No duplicate title chrome.
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to conversations" }),
  ).toBeVisible();
  await expect(page.getByLabel("Junior home")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeHidden();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();
  await expect(
    page.getByRole("group", { name: "Transcript view" }),
  ).toBeHidden();
  const menu = page.getByRole("button", { name: "Conversation menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Search transcript" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Event log" })).toBeVisible();
  await expect(page.getByRole("button", { name: "App menu" })).toBeVisible();
  await page.getByRole("button", { name: "Close conversation menu" }).click();
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("1.9k tokens")).toBeHidden();
  await expect(page.getByRole("note")).toBeHidden();

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  // Mobile collapsed control owns the total count.
  const expand = pending.getByRole("button", { name: "5 queued messages" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("5 queued messages")).toHaveCount(1);
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeHidden();

  await expand.click();
  await expect(
    pending.getByText("Also check the canary traffic from the last deploy."),
  ).toBeVisible();
  await expect(
    pending.getByRole("button", { name: "Show fewer queued messages" }),
  ).toHaveAttribute("aria-expanded", "true");
  // Footer growth must keep a completed conversation at its latest message.
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  const composer = page.getByPlaceholder("Message Junior…");
  await expect(composer).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  const shell = page.locator("main").first();
  // Rubber-band pans can change visualViewport.offsetTop while the keyboard is
  // closed. The fixed shell must stay pinned to the layout viewport.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: window.innerHeight },
      offsetTop: { configurable: true, value: 48 },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("0px");
  await expect
    .poll(() =>
      shell.evaluate(
        (element) =>
          element.style.getPropertyValue("--dashboard-viewport-height") ===
          `${window.innerHeight}px`,
      ),
    )
    .toBe(true);

  // First keyboard open docks to the visual viewport (height + offset) so the
  // focused composer lands on the visible bottom, not the layout bottom.
  // Safari can emit resize then scroll in one frame. Resize must win that burst.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 140 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe("520px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");
  // Focused reply input must stay docked at the bottom of the visual viewport.
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 140);

  // Scroll-driven Safari pans while focused must not chase the shell.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 180 },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 140);

  await composer.blur();
  // Closed keyboard must snap the shell back to the layout top even if a stale
  // visual offset remains for a frame after blur.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: window.innerHeight },
      offsetTop: { configurable: true, value: 180 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("0px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("0");

  // Open-keyboard pans with no focused editor may follow visual offset.
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 200 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("200px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await composer.focus();
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  // Keyboard resize keeps the latest message above the focused composer.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 480,
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await composer.fill("Keep the mobile composer ready");
  await composer.press("Enter");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeVisible();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Event log" }).click();
  await page.getByRole("button", { name: "Conversation menu" }).click();
  await page.getByRole("button", { name: "Hide search" }).click();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();

  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect(page).toHaveURL(`${server.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "Conversations" }),
  ).toBeVisible();

  // Log out must POST and dismiss the sheet before the response completes.
  let finishSignOut: (() => void) | undefined;
  const signOutGate = new Promise<void>((resolve) => {
    finishSignOut = resolve;
  });
  await page.route("**/api/auth/sign-out", async (route) => {
    await signOutGate;
    await route.fulfill({ json: {} });
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const openNavigationSheet = page.getByRole("dialog", { name: "Navigation" });
  const signOutRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/auth/sign-out") &&
      request.method() === "POST",
  );
  await openNavigationSheet.getByRole("button", { name: "Log out" }).click();
  await signOutRequest;
  await expect(openNavigationSheet).toBeHidden();
  finishSignOut?.();
});
