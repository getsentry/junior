import type { Page } from "@playwright/test";

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

  // Home and create share one page. It is not a conversation or a reply dock.
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to conversations" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Your conversations" }),
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
        if (form.closest("[data-composer-dock]")) {
          return "pinned-on-composer-dock";
        }
        if (!form.closest("main")) return "missing-page-scroll";
        return "landing-compose";
      }),
    )
    .toBe("landing-compose");

  const conversationList = page.getByRole("list", {
    name: "Your conversations",
  });
  await expect(conversationList.getByRole("listitem").first()).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search your conversations" }),
  ).toBeVisible();
});

test("opens and closes a conversation on mobile", async ({
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
    page.getByRole("list", { name: "Your conversations" }),
  ).toBeVisible();
  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
  });
  await expect(navigationTrigger).toBeVisible();
  await expect(page.getByRole("link", { name: "Junior home" })).toBeVisible();
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
    "Personal model spend: 7 days $0.46, 30 days $0.46",
    { exact: true },
  );
  await expect(spendCallout).toBeVisible();
  await expect(spendCallout.getByText("7d $0.46")).toBeVisible();
  await expect(spendCallout.getByText("30d $0.46")).toBeVisible();
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
  await expect(page.getByRole("link", { name: "API tokens" })).toHaveCount(0);
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
  await expect(page.getByRole("link", { name: "Junior home" })).toBeHidden();
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
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "Conversation details" });
  await expect(details).toHaveAttribute("aria-modal", "true");
  // The sheet moves focus inside it.
  await expect(details.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  // Mobile hides the title bar, so the sheet names the location.
  await expect(details.getByText("Location", { exact: true })).toBeVisible();
  await expect(details.locator(":focus")).toHaveCount(1);
  await screenshot(page, "conversation-details-sheet", {
    lightTheme: true,
    view: "mobile",
  });
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(menu).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await menu.click();
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  // The sheet moves focus inside it.
  await expect(details.locator(":focus")).toHaveCount(1);
  await page.mouse.click(8, 8);
  await expect(details).toBeHidden();
  await expect(menu).toBeFocused();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("1.9k tokens")).toBeHidden();
  await expect(page.getByRole("note")).toBeHidden();

  const pending = page.getByLabel("Pending messages");
  await expect(pending).toBeVisible();
  // Mobile collapsed control owns the total count.
  const expand = pending.getByRole("button", { name: "7 queued messages" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(pending.getByText("7 queued messages")).toHaveCount(1);
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

  // iOS Safari shrinks innerHeight with the keyboard but keeps the layout
  // viewport (documentElement.clientHeight) tall and pans the visual viewport
  // inside it. The shell must follow that pan, or it slides up off screen.
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
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe("140px");
  await expectFocusedComposerAtVisualViewportBottom(composer, 520, 140);

  // When the layout viewport itself shrank for the keyboard
  // (resizes-content), a leftover visual offset must not shove the fixed shell
  // down (composer under the keyboard).
  await page.evaluate(() => {
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 520,
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

  // Restore classic visual-dock geometry for the remaining checks.
  await page.evaluate(() => {
    Reflect.deleteProperty(document.documentElement, "clientHeight");
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
  await expect(page.getByPlaceholder("Search events…")).toBeVisible();
  await expect(page.getByPlaceholder("Search transcript…")).toBeHidden();

  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(
    page.getByRole("heading", { name: "What do you need?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Your conversations" }),
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

test("keeps the message in view while earlier history and late content load", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const generatedAt = "2026-08-07T11:00:00.000Z";
  const conversation = {
    conversationId: "long-history",
    cumulativeDurationMs: 1_000,
    displayTitle: "Long history",
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status: "completed",
    surface: "internal",
  };
  const events = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, index) => {
      const seq = from + index;
      return {
        createdAt: new Date(
          Date.parse(generatedAt) + seq * 1_000,
        ).toISOString(),
        data: {
          type: "message",
          messageId: `message-${seq}`,
          role: seq % 2 === 0 ? "user" : "assistant",
          text: `Transcript message ${seq} with enough content to occupy a visible row.`,
        },
        seq,
      };
    });
  let releaseEarlierPage: (() => void) | undefined;
  const earlierPageGate = new Promise<void>((resolve) => {
    releaseEarlierPage = resolve;
  });

  await page.route("**/api/conversations", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        conversations: [conversation],
        generatedAt,
        source: "conversation_index",
      },
    });
  });
  await page.route(
    "**/api/conversations/long-history/pending-messages",
    async (route) => {
      await route.fulfill({
        json: { conversationId: "long-history", generatedAt, messages: [] },
      });
    },
  );
  await page.route(
    "**/api/conversations/long-history/events?*",
    async (route) => {
      await earlierPageGate;
      await route.fulfill({
        json: {
          eventHistory: { status: "available" },
          events: events(0, 40),
          generatedAt,
        },
      });
    },
  );
  await page.route("**/api/conversations/long-history", async (route) => {
    await route.fulfill({
      json: {
        ...conversation,
        eventHistory: { status: "available" },
        events: events(40, 80),
        generatedAt,
        previousCursor: "before-40",
      },
    });
  });

  // A scroll event fires on the next frame, before its animation frame
  // callbacks. The transcript records the reader's place there, so wait for it
  // before the layout changes. Otherwise the place it records already
  // includes the change.
  const scrollEventHandled = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );

  await page.goto(`${dashboard.baseURL}/conversations/long-history`);
  const transcript = page.getByLabel("Conversation transcript");
  const latest = transcript.getByText("Transcript message 79 ");
  await expect(latest).toBeInViewport();

  // Scroll to the top to load earlier history. The reader keeps scrolling
  // while the page loads, so their place is where they stop, not where the
  // load started.
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(transcript.getByText("Loading earlier messages…")).toBeVisible();
  await transcript.evaluate((element) => {
    element.scrollTop = 160;
  });
  await scrollEventHandled();
  const reading = transcript.getByText("Transcript message 43 ");
  await expect(reading).toBeInViewport({ ratio: 1 });
  releaseEarlierPage?.();
  await expect(transcript.getByText("Transcript message 0 ")).toBeAttached();
  await expect(reading).toBeInViewport({ ratio: 1 });
  await expect(
    transcript.getByText("Transcript message 39 "),
  ).not.toBeInViewport();

  // Rows keep their real size while the reader scrolls up through them, so
  // the transcript never corrects the reader's own scroll. On phones, such
  // corrections make the transcript jump.
  await transcript.evaluate((element) => {
    const scrollTo = element.scrollTo.bind(element);
    element.dataset.scrollCorrections = "0";
    element.scrollTo = (...args: Parameters<typeof scrollTo>) => {
      element.dataset.scrollCorrections = String(
        Number(element.dataset.scrollCorrections) + 1,
      );
      scrollTo(...args);
    };
  });
  await transcript.hover();
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, -150);
  }
  await expect(transcript.getByText("Transcript message 30 ")).toBeInViewport();
  await expect(transcript).toHaveAttribute("data-scroll-corrections", "0");
  await transcript.getByText("Transcript message 43 ").scrollIntoViewIfNeeded();
  await scrollEventHandled();

  // Content that grows above the reader, such as an image that loads late,
  // must not push the message they are reading out of view.
  await transcript.getByText("Transcript message 20 ").evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.style.height = "1200px";
    element.append(spacer);
  });
  await expect(reading).toBeInViewport({ ratio: 1 });
});

/** Mock one completed Conversation whose server read position moves forward. */
async function mockReadPositionConversation(
  page: Page,
  input: { eventCount: number; lastReadSeq: number },
) {
  const generatedAt = "2026-08-07T11:00:00.000Z";
  const conversationId = "read-position";
  const conversation = {
    conversationId,
    cumulativeDurationMs: 1_000,
    displayTitle: "Read position",
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status: "completed",
    surface: "internal",
  };
  const state = {
    conversationId,
    eventCount: input.eventCount,
    /** Holds detail responses until it resolves. */
    detailGate: Promise.resolve(),
    reported: [] as number[],
  };
  let stored = input.lastReadSeq;

  await page.route("**/api/conversations", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        conversations: [conversation],
        generatedAt,
        source: "conversation_index",
      },
    });
  });
  await page.route(
    `**/api/conversations/${conversationId}/pending-messages`,
    async (route) => {
      await route.fulfill({
        json: { conversationId, generatedAt, messages: [] },
      });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/read-position`,
    async (route) => {
      const { lastReadSeq } = route.request().postDataJSON() as {
        lastReadSeq: number;
      };
      state.reported.push(lastReadSeq);
      stored = Math.max(stored, lastReadSeq);
      await route.fulfill({ json: { lastReadSeq: stored } });
    },
  );
  await page.route(`**/api/conversations/${conversationId}`, async (route) => {
    await state.detailGate;
    await route.fulfill({
      json: {
        ...conversation,
        eventHistory: { status: "available" },
        events: Array.from({ length: state.eventCount }, (_, seq) => ({
          createdAt: new Date(
            Date.parse(generatedAt) + seq * 1_000,
          ).toISOString(),
          data: {
            type: "message",
            messageId: `message-${seq}`,
            role: seq % 2 === 0 ? "user" : "assistant",
            text: `Transcript message ${seq} with enough content to occupy a visible row.`,
          },
          seq,
        })),
        generatedAt,
        readPosition: { lastReadSeq: stored },
      },
    });
  });
  return state;
}

test("opens where the reader left off and reports what they read", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 60,
    lastReadSeq: 20,
  });
  const { reported } = mock;

  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  const latest = transcript.getByText("Transcript message 59 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();
  await expect(latest).not.toBeInViewport();
  await screenshot(page, "conversation-unread-marker", { view: "mobile" });

  // Reading the first screen moves the shared position past the marker.
  await expect.poll(() => reported.at(-1) ?? 0).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(latest).toBeInViewport();
  await expect.poll(() => reported.at(-1)).toBe(59);
  expect(reported).toEqual([...reported].sort((left, right) => left - right));

  // Readers who prefer the latest message open there, below the marker.
  await page.goto(`${dashboard.baseURL}/settings`);
  await page.getByRole("radio", { name: /Latest message/ }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  await expect(latest).toBeInViewport();
  await expect(marker).not.toBeInViewport();
});

test("opens at new messages after a cached reopen and keeps a quick exit", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 40,
    lastReadSeq: 39,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  await expect(transcript.getByText("Transcript message 39 ")).toBeInViewport();
  await expect(marker).toHaveCount(0);

  // New messages arrive while the reader is away. The reopen shows the cached
  // copy first, then the fetch brings the new messages and the marker.
  await page.getByRole("link", { name: "Back to conversations" }).click();
  mock.eventCount = 60;
  let releaseDetail = () => {};
  mock.detailGate = new Promise((resolve) => {
    releaseDetail = resolve;
  });
  await page
    .getByRole("link", { name: /Read position/ })
    .first()
    .click();
  await expect(transcript.getByText("Transcript message 39 ")).toBeVisible();
  await expect(marker).toHaveCount(0);
  releaseDetail();
  await expect(marker).toBeInViewport();
  await expect(transcript.getByText("Transcript message 40 ")).toBeInViewport();
  await expect(
    transcript.getByText("Transcript message 59 "),
  ).not.toBeInViewport();

  // Leaving right after a scroll still saves the place.
  const reportCount = mock.reported.length;
  await transcript.getByText("Transcript message 52 ").scrollIntoViewIfNeeded();
  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect
    .poll(() => mock.reported.slice(reportCount).at(-1) ?? 0)
    .toBeGreaterThanOrEqual(52);
});
