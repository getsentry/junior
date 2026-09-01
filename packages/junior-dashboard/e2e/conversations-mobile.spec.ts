import { expect, test } from "./test";
import { mobile, screenshot } from "./screenshot";

const FOCUSED_COMPOSER_HEIGHT_PX = 520;
const FOCUSED_COMPOSER_OFFSET_TOP_PX = 140;

test("records focused mobile conversation composer", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(
      "slack:CQA123:1770003600.000200",
    )}`,
    { waitUntil: "networkidle" },
  );
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();

  const composer = page.getByPlaceholder("Message Junior…");
  await composer.focus();
  await page.evaluate(
    ({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    },
    {
      height: FOCUSED_COMPOSER_HEIGHT_PX,
      offsetTop: FOCUSED_COMPOSER_OFFSET_TOP_PX,
    },
  );
  const shell = page.locator("main").first();
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");
  await expect(composer).toBeFocused();
  await screenshot(page, "conversation-detail-focused", {
    clip: {
      height: FOCUSED_COMPOSER_HEIGHT_PX,
      width: mobile.width,
      x: 0,
      y: FOCUSED_COMPOSER_OFFSET_TOP_PX,
    },
    view: "mobile",
  });
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

test("starts a new conversation from a centered compose empty state", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(dashboard.baseURL);

  const heading = page.getByRole("heading", { name: "What do you need?" });
  const composer = page.getByLabel("Start a conversation");
  await expect(heading).toBeVisible();
  await expect(page.getByRole("button", { name: "Public" })).toBeVisible();
  await expect(composer).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  // Home and create are the same landing: simple app chrome + compose hero +
  // list nav. Not a thread destination and not a reply dock.
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to conversations" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your conversations" }),
  ).toBeVisible();
  // Legacy create deep link collapses onto home.
  await page.goto(`${dashboard.baseURL}/conversations/new`);
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(heading).toBeVisible();
  await expect
    .poll(() =>
      composer.evaluate((node) => {
        const form = node.closest("form");
        const section = node.closest('[aria-label="New conversation"]');
        const title = section?.querySelector("h2");
        if (!form || !(title instanceof HTMLElement) || !section) {
          return "missing-compose-stack";
        }
        const position = title.compareDocumentPosition(form);
        if ((position & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
          return "title-not-above-composer";
        }
        // Landing compose must live under the page scroll owner, not the reply
        // dock. Ownership markers are the product contract (see frontend policy).
        if (form.closest("[data-composer-dock]")) {
          return "pinned-on-composer-dock";
        }
        if (!form.closest("[data-create-landing-scroll]")) {
          return "missing-landing-scroll";
        }
        return "landing-compose";
      }),
    )
    .toBe("landing-compose");

  // Hero lives outside the list scroller so focus cannot pan it away.
  await expect
    .poll(() =>
      composer.evaluate((node) => {
        const frame = node.closest("[data-create-landing-scroll]");
        const list = frame?.querySelector("[data-create-landing-list]");
        if (!(frame instanceof HTMLElement) || !(node instanceof HTMLElement)) {
          return "missing-frame";
        }
        if (!(list instanceof HTMLElement)) return "missing-list-scroller";
        if (list.contains(node)) return "hero-inside-list-scroller";
        return "hero-outside-list-scroller";
      }),
    )
    .toBe("hero-outside-list-scroller");
  await composer.focus();
  await expect(composer).toBeFocused();

  // List search owns the only landing scroll region under the hero.
  const search = page.getByRole("searchbox", {
    name: "Search your conversations",
  });
  await search.focus();
  await expect(search).toBeFocused();
  await expect
    .poll(() =>
      search.evaluate((node) => {
        const list = node
          .closest("[data-create-landing-scroll]")
          ?.querySelector("[data-create-landing-list]");
        if (!(list instanceof HTMLElement)) return "missing-list-scroller";
        if (!list.contains(node)) return "search-outside-list-scroller";
        const before = list.scrollTop;
        list.scrollTop = before + 40;
        const after = list.scrollTop;
        if (after === before) {
          return list.scrollHeight > list.clientHeight
            ? "search-scroll-rejected"
            : "search-unlocked";
        }
        return "search-unlocked";
      }),
    )
    .toBe("search-unlocked");
});

test("opens and closes a conversation in the mobile workspace", async ({
  page,
  dashboard,
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
  await page.goto(`${dashboard.baseURL}/conversations`);
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  // Mobile home is the create landing (hero + list), same as desktop empty state.
  await expect(
    page.getByRole("heading", { name: "What do you need?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your conversations" }),
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
  await expect(page.getByLabel("Signed in as Dashboard User")).toBeVisible();
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
    `${dashboard.baseURL}/conversations/${encodeURIComponent("slack:CQA123:1770003600.000200")}`,
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

  // Open keyboard: shell follows live visual geometry (height + offset).
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
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");
  // Reply threads must use the dock owner, not the create landing scroll path.
  await expect
    .poll(() =>
      composer.evaluate((node) => {
        const form = node.closest("form");
        if (!form) return "missing-form";
        if (form.closest("[data-create-landing-scroll]")) {
          return "reply-on-landing-scroll";
        }
        if (!form.closest("[data-composer-dock]"))
          return "missing-composer-dock";
        if (
          !form.closest("[data-chat-scroll]") &&
          !document.querySelector("[data-chat-scroll]")
        ) {
          return "missing-chat-scroll";
        }
        // Dock is a sibling of the scroll region under ChatLayout, not inside it.
        if (form.closest("[data-chat-scroll]"))
          return "composer-inside-chat-scroll";
        return "reply-dock";
      }),
    )
    .toBe("reply-dock");

  // Focused reply input must stay docked at the bottom of the visual viewport.
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 140);

  // When the page already shrank for the keyboard, a leftover visual offset
  // must not shove the fixed shell down (composer under the keyboard).
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 520,
    });
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
    .toBe("0px");
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 0);

  // Restore classic Safari visual-dock geometry for the remaining checks.
  await page.evaluate(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 140 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");

  // Later visual updates still follow live geometry (no freeze lock-in).
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 500 },
      offsetTop: { configurable: true, value: 150 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe("500px");
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("150px");
  await expectFocusedComposerAtVisualViewportBottom(composer, 500, 150);

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
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "What do you need?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your conversations" }),
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
