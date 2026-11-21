import { viewAsParticipant } from "./conversationMenu";
import type { Locator } from "@playwright/test";
import { openRow } from "./inbox-fixture";
import { expect, test } from "../test";
import { pickOption } from "../pick-option";

/**
 * Rest the pointer on an Inbox row's head until the row stops moving, so
 * its hover actions take a click. A row that still moves under the pointer
 * makes a click retry with a forced scroll, which moves the row out from
 * under the pointer, and its hidden actions then take no click.
 */
async function restOnRow(head: Locator) {
  await head.hover();
  const row = head.locator("xpath=ancestor::*[@data-inbox-row][1]");
  let last = "";
  await expect
    .poll(
      async () => {
        // Spinners loop forever, so only transitions and height runs count.
        const now = await row.evaluate(
          (element) =>
            `${(element as HTMLElement).style.transform}:${
              element
                .getAnimations({ subtree: true })
                .filter(
                  (run) =>
                    run.playState === "running" &&
                    !(run instanceof CSSAnimation),
                ).length
            }`,
        );
        const settled = now === last;
        last = now;
        return settled;
      },
      // Longer than the focus intent, so the row has started to move.
      { intervals: [250] },
    )
    .toBe(true);
}

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  // Only participants can archive or restore.
  test.beforeEach(async ({ page }) => viewAsParticipant(page));

  test("finds an old archived conversation by title and restores it", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.goto(dashboard.baseURL);
    const sidebarLink = page.getByRole("link", {
      name: /Archived restore target/,
    });
    await expect(sidebarLink).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Go to conversation" });
    await palette.getByRole("combobox").fill("archived restore");
    await pickOption(
      palette.getByRole("option", {
        name: /Archived restore target.*Archived/,
      }),
    );
    await expect(
      page.getByRole("heading", { name: "Archived restore target" }),
    ).toBeVisible();

    const restoreRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/archive"),
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
    expect((await restoreRequest).postDataJSON()).toMatchObject({
      archived: false,
    });
    // The list shows the row again.
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    await expect(sidebarLink).toBeVisible();
  });

  test("archives and restores a conversation from its row", async ({
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
          // This route replaces the `viewAsParticipant` one.
          conversations: feed.conversations
            .filter(
              (conversation: { displayTitle: string }) =>
                !archived ||
                conversation.displayTitle !== "Dashboard QA edge cases",
            )
            .map((conversation: Record<string, unknown>) => ({
              ...conversation,
              isParticipant: true,
            })),
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
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

    const undoNotice = page.getByRole("dialog").filter({
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
    test(`returns to its list at once when a conversation archives itself (${outcome})`, async ({
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
      await page.goto(`${dashboard.baseURL}/?view=conversations`);
      await openRow(
        page.getByRole("link", { name: /Dashboard QA edge cases/ }),
      );
      await expect(
        page.getByRole("heading", { name: "Dashboard QA edge cases" }),
      ).toBeVisible();

      // The list must report the result even while it is hidden.
      await page.getByRole("button", { name: "Hide sidebar" }).click();
      await page.getByRole("button", { name: "Conversation menu" }).click();
      await page
        .getByRole("menuitem", { name: "Archive", exact: true })
        .click();

      // The list shows before the archive request finishes.
      await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);
      const conversationLink = page.getByRole("link", {
        name: /Dashboard QA edge cases/,
      });
      await expect(conversationLink).toHaveCount(0);
      releaseArchive();

      if (outcome === "success") {
        const undoNotice = page.getByRole("dialog").filter({
          hasText: "Conversation archived",
        });
        await expect(undoNotice).toContainText("Dashboard QA edge cases");
        return;
      }
      const archiveError = page.getByRole("alert").filter({
        hasText: "Could not archive",
      });
      await expect(archiveError).toContainText("Dashboard QA edge cases");
      await page.getByRole("button", { name: "Show sidebar" }).click();
      await expect(conversationLink).toBeVisible();
    });
  }

  test("on a phone, an archive toast keeps its Undo in reach", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.route("**/api/conversations/*/archive", (route) =>
      route.fulfill({
        json: {
          archivedAt: route.request().postDataJSON().archived
            ? "2026-08-21T16:45:00.000Z"
            : null,
        },
      }),
    );
    await page.goto(`${dashboard.baseURL}/?view=conversations`);
    await openRow(page.getByRole("link", { name: /Dashboard QA edge cases/ }));
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();

    const undoNotice = page
      .getByRole("region", { name: "Notifications" })
      .getByRole("dialog", { name: "Conversation archived" });
    const restoreRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        request.url().endsWith("/archive") &&
        request.postDataJSON().archived === false,
    );
    await undoNotice
      .getByRole("button", { name: "Undo archive for Dashboard QA edge cases" })
      .click();
    await restoreRequest;
    await expect(undoNotice).toHaveCount(0);
  });

  test("confirms a child archive and archives its children too", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ height: 900, width: 1600 });
    await page.route("**/api/conversations/*/archive", (route) =>
      route.fulfill({ json: { archivedAt: "2026-08-21T16:45:00.000Z" } }),
    );
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("junior:internal:dashboard-qa:advisor-plan")}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();

    const confirm = page.getByRole("alertdialog", {
      name: "Also archive its child conversations?",
    });
    await expect(confirm).toContainText("for everyone");
    const archiveRequest = page.waitForRequest(
      (request) =>
        request.method() === "PATCH" && request.url().endsWith("/archive"),
    );
    await confirm.getByRole("button", { name: "Archive" }).click();
    expect((await archiveRequest).postDataJSON()).toMatchObject({
      applyToChildren: true,
      archived: true,
    });
    // A direct link has no origin, so the archive returns to Conversations.
    await expect(page).toHaveURL(`${dashboard.baseURL}/?view=conversations`);
  });

  test("shows why a child restore is refused", async ({ page, dashboard }) => {
    const error =
      "Conversation junior:internal:dashboard-qa:advisor-plan above this one is archived. Restore it first.";
    await page.route("**/api/conversations/*/archive", (route) =>
      route.fulfill({ json: { error }, status: 409 }),
    );
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent("junior:internal:dashboard-qa:archived-thread")}`,
    );
    await page.getByRole("button", { name: "Conversation menu" }).click();
    await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
    await expect(page.getByText(error)).toBeVisible();
  });

  test.describe("expires the archive undo notice", () => {
    test.use({ controlTimers: true });
    test("expires the archive undo notice", async ({ page, dashboard }) => {
      await page.route("**/api/conversations/*/archive", async (route) => {
        await route.fulfill({
          json: { archivedAt: "2026-08-21T16:45:00.000Z" },
        });
      });
      await page.goto(`${dashboard.baseURL}/?view=conversations`);

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

  test.describe("keeps undo through a slow failed restore", () => {
    test.use({ controlTimers: true });
    test("keeps undo through a slow failed restore", async ({
      page,
      dashboard,
    }) => {
      let releaseRestore!: () => void;
      const restoreReleased = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      let restoreRequests = 0;
      await page.route("**/api/conversations/*/archive", async (route) => {
        const archived = route.request().postDataJSON().archived;
        if (archived) {
          await route.fulfill({
            json: { archivedAt: "2026-08-21T16:45:00.000Z" },
          });
          return;
        }
        restoreRequests += 1;
        if (restoreRequests === 1) {
          await restoreReleased;
          await route.fulfill({
            json: { error: "Restore failed" },
            status: 500,
          });
          return;
        }
        await route.fulfill({ json: { archivedAt: null } });
      });
      await page.goto(`${dashboard.baseURL}/?view=conversations`);

      await page.getByRole("link", { name: /Dashboard QA edge cases/ }).hover();
      await page
        .getByRole("button", { name: "Archive Dashboard QA edge cases" })
        .click();
      const undo = page.getByRole("button", {
        name: "Undo archive for Dashboard QA edge cases",
      });
      await page.clock.fastForward(5_000);
      await undo.click();
      await expect(undo).toHaveText("Restoring…");
      await expect(undo).toBeDisabled();

      // A pending restore outlives the undo window.
      await page.clock.fastForward(3_000);
      await expect(undo).toHaveText("Restoring…");

      releaseRestore();
      const restoreError = page.getByRole("dialog").filter({
        hasText: "Could not restore",
      });
      await expect(restoreError).toContainText("Dashboard QA edge cases");
      await expect(undo).toHaveText("Undo");
      await undo.click();
      await expect(undo).toHaveCount(0);
      expect(restoreRequests).toBe(2);
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
      await page.goto(`${dashboard.baseURL}/?view=conversations`);

      await restOnRow(
        page.getByRole("link", { name: /Dashboard QA edge cases/ }),
      );
      await page
        .getByRole("button", { name: "Archive Dashboard QA edge cases" })
        .click();
      const firstUndo = page.getByRole("button", {
        name: "Undo archive for Dashboard QA edge cases",
      });
      await expect(firstUndo).toBeVisible();

      // Burn most of the first notice's timer, then archive a second conversation.
      await page.clock.fastForward(5_000);
      // The row still moves as the pointer's focus lands on it, so let it
      // settle before its hidden Archive takes a click.
      await restOnRow(
        page.getByRole("link", { name: /Checkout latency triage/ }),
      );
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);

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

    // Hover again: the first hover's tooltip can cover the returned row.
    await page.mouse.move(0, 0);
    await conversationLink.hover();
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
    await page.goto(`${dashboard.baseURL}/?view=conversations`);

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
});
