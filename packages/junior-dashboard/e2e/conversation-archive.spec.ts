import { expect, test } from "./test";

test("finds an old archived conversation by title and restores it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.goto(dashboard.baseURL);
  // The landing view keeps a hidden mobile sidebar mounted alongside the
  // visible desktop one; scope to the desktop (first) instance throughout.
  const conversationLink = page
    .getByRole("link", {
      name: /Archived restore target/,
    })
    .first();
  await expect(conversationLink).toHaveCount(0);

  await page
    .getByLabel("Search your conversations")
    .first()
    .fill("archived restore");
  await expect(conversationLink).toBeVisible();
  await conversationLink.hover();
  const restoreRequest = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await page
    .getByRole("button", { name: "Restore Archived restore target" })
    .first()
    .click();
  expect((await restoreRequest).postDataJSON()).toMatchObject({
    archived: false,
  });

  await page.getByLabel("Search your conversations").first().fill("");
  await expect(conversationLink).toBeVisible();
});

test("archives and restores a conversation from the sidebar", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  let archived = false;
  await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const feed = await response.json();
    await route.fulfill({
      response,
      json: {
        ...feed,
        conversations: feed.conversations.filter(
          (conversation: { displayTitle: string }) =>
            !archived ||
            conversation.displayTitle !== "Dashboard QA edge cases",
        ),
      },
    });
  });
  await page.route("**/api/conversations/*/archive", async (route) => {
    const request = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    archived = request.archived;
    await route.fulfill({
      json: { archivedAt: archived ? "2026-08-21T16:45:00.000Z" : null },
    });
  });
  await page.goto(dashboard.baseURL);
  const selectedConversation = page.getByRole("link", {
    name: /Investigate checkout latency/,
  });
  await selectedConversation.click();
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();

  const conversationLink = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  const archiveButton = page.getByRole("button", {
    name: "Archive Dashboard QA edge cases",
  });
  await conversationLink.hover();

  const currentUrl = page.url();
  const archiveRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await archiveButton.click();
  await expect(conversationLink).toHaveCount(0);
  const archiveRequest = await archiveRequestPromise;
  expect(archiveRequest.postDataJSON()).toMatchObject({ archived: true });
  expect(page.url()).toBe(currentUrl);

  const undoNotice = page.getByRole("status").filter({
    hasText: "Conversation archived",
  });
  await expect(undoNotice).toBeVisible();
  await expect(undoNotice).toContainText("Dashboard QA edge cases");

  // Undo immediately so the 6s expiry cannot race this path. Dedicated clock
  // tests cover expiry; keep this test on archive/restore behavior only.
  const restoreRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" && request.url().endsWith("/archive"),
  );
  await page
    .getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    })
    .click();
  await expect(conversationLink).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    }),
  ).toHaveText("Restoring…");
  const restoreRequest = await restoreRequestPromise;
  expect(restoreRequest.postDataJSON()).toMatchObject({ archived: false });
  await expect(undoNotice).toHaveCount(0);
  await expect(conversationLink).toBeVisible();
  expect(page.url()).toBe(currentUrl);
});

for (const outcome of ["success", "error"] as const) {
  test(`returns home at once when a conversation archives itself (${outcome})`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    await page.route("**/api/conversations/*/archive", async (route) => {
      await archiveReleased;
      await route.fulfill(
        outcome === "success"
          ? { json: { archivedAt: "2026-08-21T16:45:00.000Z" } }
          : { json: { error: "Archive failed" }, status: 500 },
      );
    });
    await page.goto(dashboard.baseURL);
    await page.getByRole("link", { name: /Dashboard QA edge cases/ }).click();
    await expect(
      page.getByRole("heading", { name: "Dashboard QA edge cases" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).click();

    // Home shows before the archive request finishes.
    await expect(page).toHaveURL(new URL("/", dashboard.baseURL).href);
    const conversationLink = page.getByRole("link", {
      name: /Dashboard QA edge cases/,
    });
    await expect(conversationLink).toHaveCount(0);
    releaseArchive();

    if (outcome === "success") {
      const undoNotice = page.getByRole("status").filter({
        hasText: "Conversation archived",
      });
      await expect(undoNotice).toContainText("Dashboard QA edge cases");
      return;
    }
    const archiveError = page.getByRole("alert").filter({
      hasText: "Could not archive",
    });
    await expect(archiveError).toContainText("Dashboard QA edge cases");
    await expect(conversationLink).toBeVisible();
  });
}

test.describe("expires the archive undo notice", () => {
  test.use({ controlTimers: true });
  test("expires the archive undo notice", async ({ page, dashboard }) => {
    await page.route("**/api/conversations/*/archive", async (route) => {
      await route.fulfill({
        json: { archivedAt: "2026-08-21T16:45:00.000Z" },
      });
    });
    await page.goto(dashboard.baseURL);

    const conversationLink = page.getByRole("link", {
      name: /Dashboard QA edge cases/,
    });
    await conversationLink.hover();
    await page
      .getByRole("button", { name: "Archive Dashboard QA edge cases" })
      .click();

    const undo = page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    });
    await expect(undo).toBeVisible();
    await page.clock.fastForward(5_000);
    await expect(undo).toBeVisible();
    await page.clock.fastForward(1_000);
    await expect(undo).toHaveCount(0);
  });
});

test.describe("resets the archive undo timer when archiving another conversation", () => {
  test.use({ controlTimers: true });
  test("resets the archive undo timer when archiving another conversation", async ({
    page,
    dashboard,
  }) => {
    await page.route("**/api/conversations/*/archive", async (route) => {
      await route.fulfill({
        json: { archivedAt: "2026-08-21T16:45:00.000Z" },
      });
    });
    await page.goto(dashboard.baseURL);

    await page.getByRole("link", { name: /Dashboard QA edge cases/ }).hover();
    await page
      .getByRole("button", { name: "Archive Dashboard QA edge cases" })
      .click();
    const firstUndo = page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    });
    await expect(firstUndo).toBeVisible();

    // Burn most of the first notice's timer, then archive a second conversation.
    await page.clock.fastForward(5_000);
    await page.getByRole("link", { name: /Checkout latency triage/ }).hover();
    await page
      .getByRole("button", { name: "Archive Checkout latency triage" })
      .click();

    const secondUndo = page.getByRole("button", {
      name: "Undo archive for Checkout latency triage",
    });
    await expect(secondUndo).toBeVisible();
    await expect(firstUndo).toHaveCount(0);

    // A reused first-notice timer would dismiss here; a reset timer must remain.
    await page.clock.fastForward(2_000);
    await expect(secondUndo).toBeVisible();
    await page.clock.fastForward(4_000);
    await expect(secondUndo).toHaveCount(0);
  });
});

test("shows archive failures after the row returns", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  let archiveRequests = 0;
  await page.route("**/api/conversations/*/archive", async (route) => {
    archiveRequests += 1;
    if (archiveRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({
        json: { error: "Archive failed" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      json: { archivedAt: "2026-08-21T16:45:00.000Z" },
    });
  });
  await page.goto(dashboard.baseURL);

  const conversationLink = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  await conversationLink.hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();

  await expect(conversationLink).toBeVisible();
  const archiveError = page.getByRole("alert").filter({
    hasText: "Could not archive",
  });
  await expect(archiveError).toBeVisible();
  await expect(archiveError).toContainText("Dashboard QA edge cases");

  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Undo archive for Dashboard QA edge cases",
    }),
  ).toBeVisible();
  await expect(archiveError).toHaveCount(0);
});

test("keeps undo available when another archive fails", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ height: 900, width: 1600 });
  let archiveRequests = 0;
  await page.route("**/api/conversations/*/archive", async (route) => {
    archiveRequests += 1;
    if (archiveRequests === 1) {
      await route.fulfill({
        json: { archivedAt: "2026-08-21T16:45:00.000Z" },
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: { error: "Archive failed" },
      status: 500,
    });
  });
  await page.goto(dashboard.baseURL);

  const firstConversation = page.getByRole("link", {
    name: /Dashboard QA edge cases/,
  });
  await firstConversation.hover();
  await page
    .getByRole("button", { name: "Archive Dashboard QA edge cases" })
    .click();
  const undo = page.getByRole("button", {
    name: "Undo archive for Dashboard QA edge cases",
  });
  await expect(undo).toBeVisible();

  const secondConversation = page.getByRole("link", {
    name: /Checkout latency triage/,
  });
  await secondConversation.hover();
  await page
    .getByRole("button", { name: "Archive Checkout latency triage" })
    .click();

  const archiveError = page.getByRole("alert").filter({
    hasText: "Could not archive",
  });
  await expect(archiveError).toBeVisible();
  await expect(archiveError).toContainText("Checkout latency triage");
  await expect(undo).toBeVisible();
});
