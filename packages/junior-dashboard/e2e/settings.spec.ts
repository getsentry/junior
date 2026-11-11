import { expect, test } from "./test";
import {
  NOTIFICATION_TARGET_CACHE,
  NOTIFICATION_TARGET_KEY,
} from "../src/service-worker";
import { screenshot } from "./screenshot";
import { DASHBOARD_QA_CONVERSATION_ID } from "../src/mock-reporting/fixtures";

test("updates the signed-in user's display name", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Dashboard User");
  await screenshot(page, "settings", { view: "desktop" });

  await page.getByLabel("Display name").fill("Cramer Jr.");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /profile menu for Cramer Jr\./i }),
  ).toBeVisible();
});

test("saves notification working hours and the Slack schedule choice", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  await expect(
    page.getByRole("heading", { name: "Push notifications" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Push notifications are not set up for this Junior install.",
    ),
  ).toBeVisible();
  await screenshot(page, "settings-notifications");

  const saturday = page.getByRole("button", { name: "Sat", exact: true });
  await expect(saturday).toHaveAttribute("aria-pressed", "false");
  await saturday.click();
  await page.getByLabel("Start").fill("08:30");
  // Following Slack is on by default. The e2e user has no linked Slack
  // account, so the hours apply.
  const followSlack = page.getByRole("checkbox", {
    name: "Follow my Slack notification schedule",
  });
  await expect(followSlack).toBeChecked();
  await expect(
    page.getByText(
      "Junior cannot read your Slack notification schedule, so it uses the hours below.",
    ),
  ).toBeVisible();
  await screenshot(page, "settings-notifications-slack", {
    target: page
      .getByRole("heading", { exact: true, name: "Push notifications" })
      .locator(".."),
  });
  await followSlack.click();
  await expect(followSlack).not.toBeChecked();
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/notifications/schedule"),
  );
  await page.getByRole("button", { name: "Save hours" }).click();
  expect((await saved).postDataJSON()).toEqual({
    followSlack: false,
    workingHoursOnly: true,
    days: [1, 2, 3, 4, 5, 6],
    start: "08:30",
    end: "18:00",
  });
  await expect(page.getByText("Hours saved.")).toBeVisible();
  await expect(saturday).toHaveAttribute("aria-pressed", "true");
});

test("turns on push notifications from a one-time tip", async ({
  page,
  dashboard,
}) => {
  // Headless Chromium has no push service. Stand in for it, so the tip runs
  // the real permission, subscribe, and save path.
  await page.context().grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    PushManager.prototype.getSubscription = async () => null;
    PushManager.prototype.subscribe = async () =>
      ({
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
          keys: { auth: "e2e-auth", p256dh: "e2e-p256dh" },
        }),
      }) as unknown as PushSubscription;
  });
  // The e2e install has no Web Push keys, so return a configured install.
  await page.route("**/api/notifications", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), publicKey: "test-public-key" },
      response,
    });
  });
  const subscriptions: unknown[] = [];
  await page.route("**/api/notifications/subscriptions", async (route) => {
    subscriptions.push(route.request().postDataJSON());
    const response = await page.request.get(
      `${dashboard.baseURL}/api/notifications`,
    );
    await route.fulfill({
      json: {
        ...(await response.json()),
        deviceCount: 1,
        publicKey: "test-public-key",
      },
    });
  });
  await page.route("**/api/notifications/test", (route) =>
    route.fulfill({ json: { delivered: 1 } }),
  );
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        // A fixture Conversation, so the page renders a transcript.
        conversationId: DASHBOARD_QA_CONVERSATION_ID,
        messageId: "tip-message",
        status: "accepted",
      },
    });
  });
  async function startConversation(message: string) {
    await page.goto(dashboard.baseURL);
    await page.getByPlaceholder("Message Junior…").fill(message);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/conversations\/internal%3Adashboard-qa$/);
  }

  await startConversation("First question");
  const tip = page
    .getByRole("dialog")
    .filter({ hasText: "Push notifications" });
  await expect(tip).toContainText(
    "Get a push notification when Junior replies.",
  );
  await screenshot(page, "push-notifications-tip", { view: "desktop" });
  await tip.getByRole("button", { name: "Turn on" }).click();
  await expect(tip).toContainText("Push notifications are on");
  expect(subscriptions).toEqual([
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/e2e",
      keys: { auth: "e2e-auth", p256dh: "e2e-p256dh" },
    },
  ]);
  await screenshot(page, "push-notifications-tip-on", { view: "desktop" });
  await tip.getByRole("button", { name: "Send a test" }).click();
  await expect(tip).toContainText("Test sent.");
  await tip.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/settings#push-notifications`,
  );
  // Before the chrome offset, the heading scrolled out of view under it.
  await expect(
    page.getByRole("heading", { exact: true, name: "Push notifications" }),
  ).toBeInViewport();

  // The tip checks this flag before anything else, so a later Conversation
  // cannot show it again.
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        "junior:dashboard:push-notifications-tip-shown",
      ),
    ),
  ).toBe("1");
  await startConversation("Second question");
  await expect(page.getByText("Second question")).toBeVisible();
  await expect(
    page.getByText("Get a push notification when Junior replies."),
  ).toHaveCount(0);
});

test("opens a tapped notification that the app did not open", async ({
  page,
  dashboard,
}) => {
  // The service worker saves the tapped URL. iOS can lose its navigation to
  // a suspended Home Screen app, so the page opens the URL when shown.
  async function saveTappedNotification(path: string, ageMs: number) {
    await page.evaluate(
      async ({ ageMs, cacheName, key, path }) => {
        const cache = await caches.open(cacheName);
        await cache.put(
          key,
          new Response(JSON.stringify({ atMs: Date.now() - ageMs, url: path })),
        );
      },
      {
        ageMs,
        cacheName: NOTIFICATION_TARGET_CACHE,
        key: NOTIFICATION_TARGET_KEY,
        path,
      },
    );
  }

  await page.goto(dashboard.baseURL);
  await saveTappedNotification("/settings", 10 * 60_000);
  await page.reload();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);

  await saveTappedNotification("/settings", 0);
  await page.reload();
  await expect(page).toHaveURL(`${dashboard.baseURL}/settings`);
  await page.reload();
  await expect(page).toHaveURL(`${dashboard.baseURL}/settings`);
});

test("follows the system theme until the user picks one", async ({
  page,
  dashboard,
}) => {
  const root = page.locator("html");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(dashboard.baseURL);
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await expect(
    page.getByRole("button", { name: "System theme" }),
  ).toHaveAttribute("aria-pressed", "true");
  await screenshot(page, "settings-theme-light", { view: "desktop" });

  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("button", { name: "System theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
});

test("turns on composer autocorrect for this browser", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);
  const composer = page.getByPlaceholder("Message Junior…");
  await expect(composer).toHaveAttribute("autocorrect", "off");
  await expect(composer).toHaveAttribute("autocapitalize", "off");
  await expect(composer).toHaveAttribute("spellcheck", "false");
  await expect(composer).toHaveAttribute("autocomplete", "off");

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByText("Autocorrect", { exact: true }).click();

  await page.goto(dashboard.baseURL);
  await expect(composer).toHaveAttribute("autocorrect", "on");
  await expect(composer).toHaveAttribute("autocapitalize", "sentences");
  await expect(composer).toHaveAttribute("spellcheck", "true");
  await expect(composer).not.toHaveAttribute("autocomplete");
});

test("saves the auto-archive default and wait time", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  const autoArchive = page.getByRole("checkbox", {
    name: /Auto-archive conversations when done/,
  });
  const waitTime = page.getByLabel("Wait time", { exact: true });
  await expect(autoArchive).not.toBeChecked();
  await expect(waitTime).toHaveValue("24");

  await autoArchive.click();
  await expect(autoArchive).toBeChecked();
  await waitTime.selectOption({ label: "3 days" });
  await expect(waitTime).toHaveValue("72");
  await expect(waitTime).toBeEnabled();

  await page.reload();
  await expect(autoArchive).toBeChecked();
  await expect(waitTime).toHaveValue("72");

  await page.getByRole("button", { name: "Archive done now" }).click();
  await expect(page.getByRole("status")).toHaveText("Archived 1 conversation.");
  await screenshot(page, "settings-auto-archive", {
    target: page
      .getByRole("heading", { exact: true, name: "Conversations" })
      .locator(".."),
    view: "desktop",
  });
});

test("links to a settings section", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  const heading = page.getByRole("heading", {
    exact: true,
    name: "Message box",
  });
  const link = page.getByRole("link", { name: "Link to Message box" });
  // A screenshot resizes the page and drops hover, so show the link by focus.
  await link.focus();
  await screenshot(page, "settings-section-link", {
    target: heading.locator(".."),
    view: "desktop",
  });
  await link.click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/settings#message-box`);
  await expect(heading).toBeInViewport();

  await page.goto(`${dashboard.baseURL}/settings#conversations`);
  await expect(
    page.getByRole("heading", { exact: true, name: "Conversations" }),
  ).toBeInViewport();
});
