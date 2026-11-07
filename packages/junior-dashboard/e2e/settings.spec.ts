import { expect, test } from "./test";
import {
  NOTIFICATION_TARGET_CACHE,
  NOTIFICATION_TARGET_KEY,
} from "../src/service-worker";
import { screenshot } from "./screenshot";

test("updates the signed-in user's display name", async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.baseURL);
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
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

test("saves notification working hours", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/settings`);
  await expect(
    page.getByRole("heading", { name: "Phone notifications" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Phone notifications are not set up for this Junior install.",
    ),
  ).toBeVisible();
  await screenshot(page, "settings-notifications");

  const saturday = page.getByRole("button", { name: "Sat" });
  await expect(saturday).toHaveAttribute("aria-pressed", "false");
  await saturday.click();
  await page.getByLabel("Start").fill("08:30");
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/notifications/schedule"),
  );
  await page.getByRole("button", { name: "Save hours" }).click();
  expect((await saved).postDataJSON()).toEqual({
    workingHoursOnly: true,
    days: [1, 2, 3, 4, 5, 6],
    start: "08:30",
    end: "18:00",
  });
  await expect(page.getByText("Hours saved.")).toBeVisible();
  await expect(saturday).toHaveAttribute("aria-pressed", "true");
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

  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByText("Autocorrect", { exact: true }).click();

  await page.goto(dashboard.baseURL);
  await expect(composer).toHaveAttribute("autocorrect", "on");
  await expect(composer).toHaveAttribute("autocapitalize", "sentences");
  await expect(composer).toHaveAttribute("spellcheck", "true");
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
    target: page.getByRole("heading", { name: "Conversations" }).locator(".."),
    view: "desktop",
  });
});
