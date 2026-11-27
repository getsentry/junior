import type { Page } from "@playwright/test";
import {
  expandRow,
  license,
  mockInboxItems,
  openRowOf,
  prReview,
  rollout,
  rowHead,
} from "./inbox-fixture";
import { mobile, screenshot } from "../screenshot";
import { expect, test } from "../test";
import { pickOption } from "../pick-option";

// The dialog that Custom… opens.
const customOf = (page: Page) =>
  page.getByRole("dialog", { name: "Custom snooze" });

// Open the Event select of the condition at `index` in the Custom snooze
// dialog, and return its list. A list that just closed stays in the page while
// it fades out, with the same options, so wait for it to go first.
async function openEvents(page: Page, index: number) {
  const events = page.getByRole("listbox", { name: "Events" });
  await expect(events).toHaveCount(0);
  await customOf(page)
    .getByRole("combobox", { name: "Event" })
    .nth(index)
    .click();
  await expect(events).toBeVisible();
  return events;
}

// Pick the Event of the condition at `index` in the Custom snooze dialog.
async function pickEvent(page: Page, index: number, phrase: string) {
  const events = await openEvents(page, index);
  await pickOption(events.getByRole("option", { exact: true, name: phrase }));
}

// The next snooze that the page saves.
const snoozePost = (page: Page) =>
  page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/api/inbox/snoozes"),
  );

// Only the inbox project runs `@new` tests.
test.describe("custom snooze conditions", { tag: "@new" }, () => {
  const checkout = "Investigate checkout latency";

  test("a pull request row snoozes until Events on its pull request", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    const row = page
      .getByRole("listitem")
      .filter({ hasText: "Pin the release train" });
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await screenshot(page, "inbox-snooze-event-menu", {
      lightTheme: true,
      view: "desktop",
    });
    await menu.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    // The dialog opens with one condition on the row's own pull request, at
    // its Event.
    await expect(
      dialog.getByRole("button", { exact: true, name: "This pull request" }),
    ).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Event" })).toBeFocused();
    // Snooze skips the untouched condition, so nothing ends the snooze yet.
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    await expect(dialog.getByText("Pick a time or an event.")).toBeVisible();
    await pickEvent(page, 0, "is merged");
    await dialog.getByRole("button", { name: "Add condition" }).click();
    await pickEvent(page, 1, "is closed without merging");
    // The viewer can dismiss the ask, so the Events can dismiss it.
    await dialog.getByRole("button", { name: "Dismiss" }).click();
    await expect(
      dialog.getByRole("group", { name: "When this pull request is merged" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze-event", {
      lightTheme: true,
      view: "desktop",
    });
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: prReview.rootConversationId,
      inboxItemId: prReview.id,
      triggers: [
        { eventType: "pull_request.merged", outcome: "resolve" },
        { eventType: "pull_request.closed_unmerged", outcome: "resolve" },
      ],
    });
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
  });

  test("a time with the untouched condition snoozes until the time", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    await expect(
      dialog.getByRole("group", { name: "New condition" }),
    ).toBeVisible();
    // Desktop only: a phone opens the row in a sheet, which a resize
    // would close.
    await screenshot(page, "inbox-snooze-custom-condition", {
      lightTheme: true,
      view: "desktop",
    });
    await dialog.getByLabel("Wake at").fill("2099-01-05T09:00");
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: prReview.rootConversationId,
      inboxItemId: prReview.id,
      wakeAt: expect.stringMatching(/^2099-01-05T/),
    });
  });

  test("a pull request row snoozes until it gets new commits or its merge conflict clears", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    const events = await openEvents(page, 0);
    for (const phrase of [
      "is reopened",
      "is converted to a draft",
      "gets new commits",
      "gets a review request",
      "no longer has a merge conflict",
    ]) {
      await expect(
        events.getByRole("option", { exact: true, name: phrase }),
      ).toBeVisible();
    }
    // Desktop only: a phone opens the row in a sheet, which a resize
    // would close.
    await screenshot(page, "inbox-snooze-pull-request-events", {
      lightTheme: true,
      view: "desktop",
    });
    await pickOption(
      events.getByRole("option", { exact: true, name: "gets new commits" }),
    );
    await dialog.getByRole("button", { name: "Add condition" }).click();
    await pickEvent(page, 1, "no longer has a merge conflict");
    await expect(
      dialog.getByRole("group", {
        name: "When this pull request no longer has a merge conflict",
      }),
    ).toBeVisible();
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: prReview.rootConversationId,
      inboxItemId: prReview.id,
      triggers: [
        { eventType: "pull_request.synchronized", outcome: "wake" },
        { eventType: "pull_request.merge_conflict.resolved", outcome: "wake" },
      ],
    });
  });

  test("the Event list of a pull request groups its Events by name and filters as the viewer types", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    const events = await openEvents(page, 0);
    await expect(
      events.getByRole("group", { name: "Review" }).getByRole("option"),
    ).toHaveText([
      "is approved",
      "gets changes requested",
      "gets a review comment",
    ]);
    await expect(
      events.getByRole("group", { name: "Checks" }).getByRole("option"),
    ).toHaveText([
      "fails its checks",
      "passes its checks",
      "passes its checks again",
    ]);

    // The filter takes the keys at once and matches phrases and Event names.
    const filter = page.getByPlaceholder("Filter events");
    await expect(filter).toBeFocused();
    await page.keyboard.type("merge conflict");
    await expect(events.getByRole("option")).toHaveText([
      "gets a merge conflict",
      "no longer has a merge conflict",
    ]);
    await expect(
      events.getByRole("group", { name: "Merge conflict" }),
    ).toBeVisible();
    // Desktop only: a phone opens the row in a sheet, which a resize
    // would close.
    await screenshot(page, "inbox-snooze-event-filter", {
      lightTheme: true,
      view: "desktop",
    });
    await filter.fill("nothing like this");
    await expect(events.getByText("No events match.")).toBeVisible();
    // Every Event here is a pull request Event, so that part matches none.
    await filter.fill("pull");
    await expect(events.getByText("No events match.")).toBeVisible();
    await filter.fill("draft");
    await page.keyboard.press("Enter");
    await expect(
      dialog.getByRole("group", {
        name: "When this pull request is converted to a draft",
      }),
    ).toBeVisible();
  });

  test("many conditions keep Snooze on a short screen", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize({ height: 560, width: 1280 });
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    for (let i = 0; i < 8; i += 1) {
      await dialog.getByRole("button", { name: "Add condition" }).click();
    }
    await expect(
      dialog.getByRole("button", { exact: true, name: "Snooze" }),
    ).toBeInViewport({ ratio: 1 });
  });

  test("an Event wakes an ask that the viewer cannot dismiss", async ({
    dashboard,
    page,
  }) => {
    const ask = { ...prReview, canAct: false, canAnswer: false };
    await mockInboxItems(page, { open: [license, ask] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${ask.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await menu.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    await expect(
      dialog.getByRole("group", { name: "On the event" }),
    ).toHaveCount(0);
    await pickEvent(page, 0, "passes its checks");
    // A condition picked twice is one trigger.
    await dialog.getByRole("button", { name: "Add condition" }).click();
    await pickEvent(page, 1, "passes its checks");
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: ask.rootConversationId,
      inboxItemId: ask.id,
      triggers: [{ eventType: "pull_request.checks.passed", outcome: "wake" }],
    });
    // The ask leaves the list. The Inbox opens the next row.
    await expect(
      page.getByRole("listitem").filter({ hasText: ask.subject.object.title }),
    ).toHaveCount(0);
  });

  test("an ask with no subject snoozes until a time or an Event on a pull request that the viewer finds", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(page, checkout));
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await menu.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    // The ask names no resource, so the dialog opens at the condition's
    // page, and the search waits for the viewer.
    const pick = dialog.getByRole("button", {
      name: "Pick a pull request or issue",
    });
    await expect(pick).toBeFocused();
    await expect(dialog.getByLabel("Wake at")).toBeInViewport();
    await page.keyboard.press("Enter");
    const search = page.getByPlaceholder(
      "Search pull requests or paste a link",
    );
    await expect(search).toBeFocused();
    await expect(page.getByRole("option")).toHaveCount(0);
    await search.fill("composer");
    const found = page.getByRole("option", { name: /getsentry\/junior#3842/ });
    await expect(found).toBeVisible();
    await screenshot(page, "inbox-snooze-event-search", {
      lightTheme: true,
      view: "desktop",
    });
    await pickOption(found);
    await pickEvent(page, 0, "is merged");
    await expect(
      dialog.getByRole("group", {
        name: "When getsentry/junior#3842 is merged",
      }),
    ).toBeVisible();
    // A time too: the first of them ends the snooze.
    await dialog.getByLabel("Wake at").fill("2099-01-05T09:00");
    await screenshot(page, "inbox-snooze-named-resource", {
      lightTheme: true,
      view: "desktop",
    });
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: rollout.rootConversationId,
      inboxItemId: rollout.id,
      triggers: [
        {
          eventType: "pull_request.merged",
          outcome: "wake",
          resourceUrl: "https://github.com/getsentry/junior/pull/3842",
        },
      ],
      wakeAt: expect.stringMatching(/^2099-01-05T/),
    });
    await expect(
      page
        .getByRole("region", { name: "To do" })
        .getByRole("link", { name: new RegExp(checkout) }),
    ).toHaveCount(0);
  });

  test("a found open pull request is picked only once its card says whether it is a draft", async ({
    dashboard,
    page,
  }) => {
    // Hold the live cards until the test lets them through.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/objects",
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await mockInboxItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(page, checkout));
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page
      .getByRole("dialog", { name: "Snooze until" })
      .getByRole("button", { name: "Custom…" })
      .click();
    await customOf(page)
      .getByRole("button", { name: "Pick a pull request or issue" })
      .click();
    await page
      .getByPlaceholder("Search pull requests or paste a link")
      .fill("reference chips");
    const found = page.getByRole("option", { name: /getsentry\/junior#3838/ });
    await expect(found).toHaveAttribute("aria-disabled", "true");

    release();
    await expect(found).not.toHaveAttribute("aria-disabled", "true");
    await pickOption(found);
    await expect(
      customOf(page).getByRole("combobox", { name: "Event" }),
    ).toBeVisible();
  });

  // Hold the live cards, and open the search of a new snooze condition.
  async function searchWithHeldCards(
    page: Page,
    dashboard: { baseURL: string },
  ) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/objects",
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await mockInboxItems(page, { open: [license, rollout] });
    await page.goto(`${dashboard.baseURL}/inbox`);
    await expandRow(rowHead(page, checkout));
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    await page
      .getByRole("dialog", { name: "Snooze until" })
      .getByRole("button", { name: "Custom…" })
      .click();
    await customOf(page)
      .getByRole("button", { name: "Pick a pull request or issue" })
      .click();
    const search = page.getByPlaceholder(
      "Search pull requests or paste a link",
    );
    await search.fill("composer");
    const option = (number: number) =>
      page.getByRole("option", { name: new RegExp(`#${number}\\b`) });
    // While the open rows wait, the first merged row has the highlight.
    await expect(option(3842)).toHaveAttribute("aria-disabled", "true");
    await expect(option(3760)).toHaveAttribute("aria-selected", "true");
    return { option, release, search };
  }

  test("Enter picks the top found pull request once the cards arrive", async ({
    dashboard,
    page,
  }) => {
    const { option, release, search } = await searchWithHeldCards(
      page,
      dashboard,
    );
    release();
    await expect(option(3842)).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");
    await pickEvent(page, 0, "is merged");
    await expect(
      customOf(page).getByRole("group", {
        name: "When getsentry/junior#3842 is merged",
      }),
    ).toBeVisible();
  });

  test("a highlight that the viewer moves stays when the cards arrive", async ({
    dashboard,
    page,
  }) => {
    const { option, release, search } = await searchWithHeldCards(
      page,
      dashboard,
    );
    await search.press("ArrowDown");
    await expect(option(3701)).toHaveAttribute("aria-selected", "true");
    release();
    await expect(option(3842)).not.toHaveAttribute("aria-disabled", "true");
    await expect(option(3701)).toHaveAttribute("aria-selected", "true");
  });

  test("a pull request row snoozes until an Event on its pull request or an issue that the viewer pastes", async ({
    dashboard,
    page,
  }) => {
    await page.setViewportSize(mobile);
    await mockInboxItems(page, { open: [license, prReview] });
    // A phone shows the Inbox list on its own page.
    await page.goto(
      `${dashboard.baseURL}/inbox?view=inbox&type=prs&item=${prReview.id}`,
    );
    // A phone opens the linked row in a sheet.
    await page
      .getByRole("dialog")
      .getByRole("button", { exact: true, name: "Snooze" })
      .click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await menu.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    await pickEvent(page, 0, "gets a new comment");
    await dialog.getByRole("button", { name: "Add condition" }).click();
    await dialog
      .getByRole("button", { exact: true, name: "This pull request" })
      .nth(1)
      .click();
    const issue = "https://github.com/getsentry/junior/issues/77";
    await page
      .getByPlaceholder("Search pull requests or paste a link")
      .fill(issue);
    await pickOption(page.getByRole("option", { name: issue }));
    // The second condition offers the issue's Events.
    const events = await openEvents(page, 1);
    await expect(
      events.getByRole("option", { exact: true, name: "is merged" }),
    ).toHaveCount(0);
    await pickOption(
      events.getByRole("option", { exact: true, name: "is closed" }),
    );
    await expect(
      dialog.getByRole("group", { name: "When the issue is closed" }),
    ).toBeVisible();
    await screenshot(page, "inbox-snooze-named-resource", {
      lightTheme: true,
      view: "mobile",
    });
    const created = snoozePost(page);
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    expect((await created).postDataJSON()).toEqual({
      conversationId: prReview.rootConversationId,
      inboxItemId: prReview.id,
      triggers: [
        { eventType: "pull_request.comment.created", outcome: "wake" },
        { eventType: "issue.closed", outcome: "wake", resourceUrl: issue },
      ],
    });
    // The sheet closes under the dialog, back to the list, and the row
    // leaves it.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: prReview.subject.object.title }),
    ).toHaveCount(0);
  });

  test("a pasted link that the viewer cannot snooze on offers no Events", async ({
    dashboard,
    page,
  }) => {
    await mockInboxItems(page, { open: [license, prReview] });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs&item=${prReview.id}`);
    await openRowOf(page).getByRole("button", { name: "Snooze" }).click();
    const menu = page.getByRole("dialog", { name: "Snooze until" });
    await menu.getByRole("button", { name: "Custom…" }).click();
    const dialog = customOf(page);
    // The page button opens the search, which takes the keys at once.
    await dialog
      .getByRole("button", { exact: true, name: "This pull request" })
      .click();
    const search = page.getByPlaceholder(
      "Search pull requests or paste a link",
    );
    await expect(search).toBeFocused();
    await page.keyboard.type("nothing like this");
    await expect(
      page.getByText("No pull requests match. Paste a link"),
    ).toBeVisible();
    // The mock viewer cannot see this repository.
    const hidden = "https://github.com/acme/private/pull/1";
    await search.fill(hidden);
    await pickOption(page.getByRole("option", { name: hidden }));
    await expect(
      dialog.getByText("You cannot snooze on this link."),
    ).toBeVisible();
    // A condition on another page is not skipped while it has no Event.
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    await expect(
      dialog.getByText("Finish each condition, or remove it."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: "Event" }),
    ).toBeDisabled();
    // Back to the row's own pull request, from the keyboard.
    await dialog.getByRole("button", { exact: true, name: hidden }).click();
    await expect(search).toBeFocused();
    await page.keyboard.press("Enter");
    await pickEvent(page, 0, "is merged");
    await expect(
      dialog.getByRole("group", { name: "When this pull request is merged" }),
    ).toBeVisible();
    // A removed condition leaves only the time, which is not set.
    await dialog.getByRole("button", { name: "Remove condition" }).click();
    await dialog.getByRole("button", { exact: true, name: "Snooze" }).click();
    await expect(dialog.getByText("Pick a time or an event.")).toBeVisible();
  });
});
