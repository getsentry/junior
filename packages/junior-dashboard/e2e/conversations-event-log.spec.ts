import { chooseTranscriptView } from "./conversationMenu";
import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";
import { mockDashboardApis, withRequestedMailbox } from "./harness";

test.use({ locale: "en-US", timezoneId: "America/New_York" });

test("inspects all reporting events and searches full event data", async ({
  context,
  page,
  dashboard,
}) => {
  const conversationId = "slack:CQA123:1770003600.000200";
  const response = await page.request.get(
    `${dashboard.baseURL}/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  const report = await response.json();
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  const transcript = page.getByLabel("Conversation transcript", {
    exact: true,
  });
  const toolRow = transcript.getByRole("button", { name: /^webSearch/ });
  const activity = transcript
    .locator('[data-slot="collapsible"]')
    .filter({
      has: page.getByRole("button", {
        includeHidden: true,
        name: /^webSearch/,
      }),
    })
    .first();
  await activity.locator(':scope > [data-slot="collapsible-trigger"]').click();
  await toolRow.focus();
  await page.keyboard.press("Enter");
  const toolResult = transcript
    .locator("pre")
    .filter({ hasText: "payments-v42 deploy notes" });
  await expect(toolResult).toBeVisible();
  await expect(toolRow).toHaveAttribute("aria-expanded", "true");
  await toolRow.click();
  await expect(toolResult).toBeHidden();
  await expect(toolRow).toHaveAttribute("aria-expanded", "false");

  // Search must still reveal a result that the reader has closed.
  await page.getByRole("button", { name: "Search transcript" }).click();
  await page
    .getByPlaceholder("Search transcript…")
    .fill("payments-v42 deploy notes");
  await expect(toolResult).toBeVisible();
  await page.getByPlaceholder("Search transcript…").fill("");
  await expect(toolResult).toBeHidden();

  await chooseTranscriptView(page, "Event log");
  const log = page.getByRole("region", { name: "Conversation event log" });
  const entries = log.getByRole("button", { name: /^Event \d+:/ });
  await expect(entries).toHaveCount(report.events.length);
  expect(
    await entries.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    ),
  ).toEqual(
    report.events.map(
      (event: { seq: number; data: { type: string } }) =>
        `Event ${event.seq}: ${event.data.type}`,
    ),
  );
  await expect(
    log.getByRole("button", { name: "Event 1: turn_lifecycle", exact: true }),
  ).toContainText("started");
  await screenshot(page, "conversation-event-log");

  const entry = log.getByRole("button", {
    name: "Event 3: assistant_message",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Conversation details", exact: true })
    .click();
  const conversationDetails = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await expect(conversationDetails).toBeVisible();
  await entry.focus();
  await page.keyboard.press("Enter");
  await expect(conversationDetails).toBeHidden();
  await expect(entry).toBeFocused();
  const panel = page.getByRole("complementary", {
    name: "Event details",
    exact: true,
  });
  await expect(panel.getByText("Call usage", { exact: true })).toBeVisible();
  // The open entry is in the URL, so a reader can share a link to it.
  await expect(page).toHaveURL(/[?&]event=3(&|$)/);
  await expect(
    panel.getByText("openai/gpt-5.6-sol", { exact: true }),
  ).toBeVisible();
  await expect(panel.locator("pre")).toBeHidden();
  const close = panel.getByRole("button", { name: "Close event details" });
  // The log stays interactive while the selected event is open.
  const otherEntry = log.getByRole("button", {
    name: "Event 1: turn_lifecycle",
    exact: true,
  });
  // Keyboard selection follows the filtered rows and keeps details open.
  const eventSearch = log.getByRole("searchbox", { name: "Search events" });
  await eventSearch.fill("turn_lifecycle");
  await otherEntry.focus();
  await otherEntry.press("ArrowDown");
  const laterEntry = log.getByRole("button", {
    name: "Event 8: turn_lifecycle",
    exact: true,
  });
  await expect(laterEntry).toBeFocused();
  await expect(laterEntry).toHaveAttribute("aria-expanded", "true");
  await expect(otherEntry).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/[?&]event=8(&|$)/);
  await laterEntry.press("ArrowDown");
  await expect(laterEntry).toBeFocused();
  await expect(page).toHaveURL(/[?&]event=8(&|$)/);
  // The step buttons follow the same filtered rows.
  await expect(
    panel.getByRole("button", { name: "Next event" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Previous event" }).click();
  await expect(page).toHaveURL(/[?&]event=1(&|$)/);
  await laterEntry.press("ArrowUp");
  await expect(otherEntry).toBeFocused();
  await eventSearch.fill("");
  await expect(
    panel.getByRole("heading", { name: "turn_lifecycle", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/[?&]event=1(&|$)/);
  await entry.click();
  await expect(
    panel.getByRole("heading", { name: "assistant_message", exact: true }),
  ).toBeVisible();
  // Conversation details were open before the event, so they come back.
  await close.click();
  await expect(conversationDetails).toBeVisible();
  await expect(entry).toBeFocused();
  await entry.click();
  await expect(conversationDetails).toBeHidden();
  await screenshot(page, "conversation-event-details");
  const localTime = log.getByRole("button", {
    name: "Use local time",
    exact: true,
  });
  await expect(localTime).toHaveAttribute("aria-pressed", "false");
  await expect(entry.getByText("11:54:09.000", { exact: true })).toBeVisible();
  await localTime.click();
  await expect(localTime).toHaveAttribute("aria-pressed", "true");
  await expect(localTime).toHaveText("ET");
  await expect(entry.getByText("07:54:09.000", { exact: true })).toBeVisible();
  await expect(panel.locator("header time")).toContainText("07:54:09");
  await page.reload();
  await expect(localTime).toHaveAttribute("aria-pressed", "true");
  await expect(entry.getByText("07:54:09.000", { exact: true })).toBeVisible();
  const secondTab = await context.newPage();
  await mockDashboardApis(secondTab);
  await secondTab.goto(page.url());
  const secondToggle = secondTab.getByRole("button", {
    name: "Use local time",
    exact: true,
  });
  await expect(secondToggle).toHaveAttribute("aria-pressed", "true");
  await secondToggle.click();
  await expect(localTime).toHaveAttribute("aria-pressed", "false");
  await expect(entry.getByText("11:54:09.000", { exact: true })).toBeVisible();
  // UTC mode reads like local mode. The header leaves out milliseconds, so
  // it fits beside the actions. The tooltip and ISO value keep them.
  await expect(panel.locator("header time")).toHaveText(
    "Aug 7, 2026, 11:54:09 UTC",
  );
  await expect(panel.locator("header time")).toHaveAttribute(
    "title",
    "Aug 7, 2026, 11:54:09.000 UTC",
  );
  await expect(panel.locator("header time")).toHaveAttribute(
    "datetime",
    report.events.find((event: { seq: number }) => event.seq === 3).createdAt,
  );
  await secondTab.close();
  await page.bringToFront();
  await localTime.click();
  await expect(panel.locator("header time")).toContainText("07:54:09");
  await panel.getByText("Raw JSON", { exact: true }).click();
  const rawJson = JSON.stringify(
    report.events.find((event: { seq: number }) => event.seq === 3),
    null,
    2,
  );
  await expect(panel.locator("pre")).toHaveText(rawJson);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: dashboard.baseURL,
  });
  await panel.getByRole("button", { name: "Copy JSON", exact: true }).click();
  const copied = panel.getByRole("button", { name: "Copied", exact: true });
  await expect(copied).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    rawJson,
  );
  // A denied write must not keep the previous success state or block retry.
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () =>
        Promise.reject(new DOMException("Clipboard denied", "NotAllowedError")),
    });
  });
  await copied.click();
  const failedCopy = panel.getByRole("button", {
    name: "Copy failed",
    exact: true,
  });
  await expect(failedCopy).toBeVisible();
  await page.evaluate(() =>
    Reflect.deleteProperty(navigator.clipboard, "writeText"),
  );
  await failedCopy.click();
  await expect(copied).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    rawJson,
  );
  await otherEntry.click();
  await entry.click();
  await expect(panel.locator("pre")).toBeHidden();
  await close.click();
  await expect(panel).toBeHidden();
  await expect(entry).toBeFocused();

  // Escape also closes details while focus stays in the interactive log.
  await entry.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(entry).toBeFocused();

  // A resize keeps the selected event in a dismissable mobile sheet.
  await entry.click();
  await page.setViewportSize({ width: 390, height: 844 });
  // The sheet title names the event, so find the sheet by its label.
  const sheet = page.locator('[role="dialog"][aria-label="Event details"]');
  await expect(
    sheet.getByRole("heading", { name: "assistant_message", exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Close", exact: true }),
  ).toBeVisible();
  await screenshot(page, "conversation-event-details-mobile");
  // The sheet covers the log, so it steps through the rows itself.
  const nextSeq =
    report.events[
      report.events.findIndex((event: { seq: number }) => event.seq === 3) + 1
    ];
  await sheet.getByRole("button", { name: "Next event" }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]event=${nextSeq.seq}(&|$)`));
  await expect(
    sheet.getByRole("heading", { name: nextSeq.data.type, exact: true }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Previous event" }).click();
  await expect(page).toHaveURL(/[?&]event=3(&|$)/);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(entry).toBeFocused();
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page).not.toHaveURL(/[?&]event=/);

  const search = page.getByPlaceholder("Search events…");
  await search.fill("memory-checkout-runbook");
  await expect(entries).toHaveCount(1);
  await expect(entries).toHaveAttribute("aria-label", "Event 2: turn_context");
  await search.fill("no-such-event-data");
  await expect(log.getByText("No events match your search.")).toBeVisible();
  await search.fill("");
  await expect(entries).toHaveCount(report.events.length);
  // The title in the Event log breadcrumb leads back to the Conversation.
  await page.getByTitle("Back to conversation").click();
  await expect(log).toBeHidden();
  await expect(
    page.getByText(
      "Find the slow checkout requests from the last deployment.",
      { exact: true },
    ),
  ).toBeVisible();

  // Both views fork and send the first message with retry-safe requests.
  const forkAction = page
    .getByRole("button", { name: "Fork after this message" })
    .last();
  await forkAction.click();
  const forkDialog = page.getByRole("dialog", {
    name: "Fork Conversation",
    exact: true,
  });
  await expect(
    forkDialog.getByRole("button", { name: "Fork and send", exact: true }),
  ).toBeDisabled();
  await screenshot(page, "conversation-fork-dialog");
  await expect(
    forkDialog.getByRole("textbox", { name: "Message" }),
  ).toBeFocused();
  await forkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(forkDialog).toBeHidden();
  await expect(forkAction).toBeFocused();
  await chooseTranscriptView(page, "Event log");
  const reply = report.events.findLast(
    (event: { data: { type: string; role?: string } }) =>
      event.data.type === "message" && event.data.role === "assistant",
  );
  await log
    .getByRole("button", { name: `Event ${reply.seq}: message`, exact: true })
    .click();
  await page
    .getByRole("complementary", { name: "Event details", exact: true })
    .getByRole("button", { name: "Fork after this message" })
    .click();
  const requests: Array<{ messageId: string; idempotencyKey: string }> = [];
  const messages: Array<{ message: string; idempotencyKey: string }> = [];
  const forkId = "local:web:fork-browser-test";
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}/messages`,
    async (route) => {
      messages.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          conversationId: forkId,
          messageId: "fork-first-message",
          status: "accepted",
        },
      });
    },
  );
  await page.route(
    `**/api/conversations/${encodeURIComponent(conversationId)}/forks`,
    async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill(
        requests.length === 1
          ? {
              status: 503,
              json: { error: "Could not create the fork. Try again." },
            }
          : { json: { conversationId: forkId } },
      );
    },
  );
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}*`,
    (route) =>
      route.fulfill({
        json: withRequestedMailbox(route, {
          ...report,
          conversationId: forkId,
          forkedFromConversationId: conversationId,
          forkedFromTitle: report.displayTitle,
          events: [],
          isParticipant: true,
          status: "completed",
          forks: [],
        }),
      }),
  );
  await forkDialog
    .getByRole("textbox", { name: "Message" })
    .fill("Try the other region.");
  const forkAndSend = forkDialog.getByRole("button", {
    name: "Fork and send",
    exact: true,
  });
  await forkAndSend.click();
  await expect(forkDialog.getByRole("alert")).toHaveText(
    "Could not create the fork. Try again.",
  );
  expect(messages).toHaveLength(0);
  await forkAndSend.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(forkId)));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.messageId).toBe(reply.data.messageId);
  expect(messages).toEqual([
    {
      idempotencyKey: requests[0]?.idempotencyKey,
      message: "Try the other region.",
    },
  ]);
  await expect(
    page
      .getByRole("navigation", { name: "Conversation forks" })
      .getByRole("link", { name: report.displayTitle, exact: true }),
  ).toHaveAttribute(
    "href",
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
  await screenshot(page, "conversation-fork-links");
});

test("loads earlier events without merging tool starts and results", async ({
  page,
  dashboard,
}) => {
  const conversationId = "slack:CQA456:1770021600.000600";
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );

  await expect(
    page.getByRole("heading", { name: "Package release and self-update" }),
  ).toBeVisible();
  await expect(page.getByText("Released the package.")).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Load earlier events" }),
  ).toHaveCount(0);
  await chooseTranscriptView(page, "Event log");
  const log = page.getByRole("region", { name: "Conversation event log" });
  await expect(
    log.getByRole("button", { name: "Event 2: tool_calls", exact: true }),
  ).toContainText("bash · running");
  await expect(
    log.getByRole("button", { name: "Event 3: tool_calls", exact: true }),
  ).toContainText("bash · completed");
  await expect(log.getByText(/Released the package/)).toBeVisible();

  // A link to an event before the first page loads earlier history to open it.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}?event=2`,
  );
  const linked = page.getByRole("complementary", {
    name: "Event details",
    exact: true,
  });
  await expect(linked).toBeVisible();
  const linkedEntry = page
    .getByRole("region", { name: "Conversation event log" })
    .getByRole("button", { name: "Event 2: tool_calls", exact: true });
  await expect(linkedEntry).toBeAttached();
  // Closing a linked event must not open the default Conversation panel.
  await linked.getByRole("button", { name: "Close event details" }).click();
  await expect(linked).toBeHidden();
  await expect(
    page.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    }),
  ).toBeHidden();
  await expect(linkedEntry).toBeFocused();
  await linkedEntry.click();
  await expect(linked).toBeVisible();
  await page
    .getByRole("navigation", { name: "Your conversations" })
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(linked).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]event=/);
});

test("mounts only the event log rows near the viewport", async ({
  page,
  dashboard,
}) => {
  // The rich transcript renders all 2,000 events before the event log opens.
  test.setTimeout(60_000);
  await page.setViewportSize(desktop);
  const conversationId = "slack:CQA456:1770021600.000600";
  const api = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const response = await page.request.get(`${dashboard.baseURL}${api}`);
  const report = await response.json();
  const startedAt = Date.parse(report.startedAt);
  report.events = Array.from({ length: 2000 }, (_, index) => ({
    seq: index + 1,
    createdAt: new Date(startedAt + index * 1000).toISOString(),
    data: {
      type: "message",
      messageId: `message-${index + 1}`,
      role: index % 2 ? "assistant" : "user",
      text: `Event log row ${index + 1}.`,
    },
  }));
  delete report.previousCursor;
  await page.route(`**${api}*`, (route) =>
    route.fulfill({ json: withRequestedMailbox(route, report) }),
  );
  // A link reads the page around its event. Here that page holds them all.
  await page.route(`**${api}/events?*`, (route) =>
    route.fulfill({
      json: {
        eventHistory: report.eventHistory,
        events: report.events,
        generatedAt: report.generatedAt,
      },
    }),
  );
  await page.goto(`${dashboard.baseURL}${api.replace("/api", "")}`);
  await chooseTranscriptView(page, "Event log");
  const log = page.getByRole("region", { name: "Conversation event log" });
  const entry = (seq: number) =>
    log.getByRole("button", { name: `Event ${seq}: message`, exact: true });
  const mounted = log.locator("[data-event-seq]");
  await expect(log.getByRole("status")).toHaveText("2000 loaded events");
  await expect(entry(2000)).toBeInViewport();
  expect(await mounted.count()).toBeLessThan(80);

  await page
    .locator("[data-chat-scroll]")
    .evaluate((root) => root.scrollTo({ top: 0 }));
  await expect(entry(1)).toBeInViewport();
  await expect(entry(2000)).not.toBeAttached();
  expect(await mounted.count()).toBeLessThan(80);

  // Arrow keys move past the end of the mounted range and mount the rows
  // they reach. The row that holds the reader's place can stay mounted
  // further down, so find the first gap from the top.
  const seqs = await mounted.evaluateAll((rows) =>
    rows.map((row) => Number(row.getAttribute("data-event-seq"))),
  );
  const target = seqs.findIndex((seq, index) => seq !== index + 1) + 1;
  expect(target).toBeGreaterThan(1);
  await expect(entry(target)).not.toBeAttached();
  await entry(1).focus();
  for (let seq = 2; seq <= target; seq++) {
    await page.keyboard.press("ArrowDown");
  }
  await expect(entry(target)).toBeFocused();
  await expect(entry(target)).toBeInViewport();
  await expect(entry(target)).toHaveAttribute("aria-expanded", "true");

  // A link to a far event mounts and reveals its row.
  await page.goto(`${dashboard.baseURL}${api.replace("/api", "")}?event=1000`);
  const details = page.getByRole("complementary", {
    name: "Event details",
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(entry(1000)).toBeInViewport();
  await expect(entry(1000)).toHaveAttribute("aria-expanded", "true");
  expect(await mounted.count()).toBeLessThan(80);
  await details.getByRole("button", { name: "Close event details" }).click();
  await expect(details).toBeHidden();
  // Move the pointer off the toolbar, so no tooltip covers the capture.
  await entry(1000).hover();
  await screenshot(page, "conversation-event-log-virtual");

  // Search reads every loaded event, not only the mounted rows.
  await expect(entry(1234)).not.toBeAttached();
  await log.getByRole("searchbox", { name: "Search events" }).fill("row 1234.");
  await expect(log.getByRole("status")).toHaveText("1 of 2000 loaded events");
  await expect(entry(1234)).toBeInViewport();
});

for (const width of [1440, 390]) {
  test(`distinguishes view switches from resumed live activity (${width}px)`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const conversationId = "slack:CQA123:1770003600.000200";
    const api = `/api/conversations/${encodeURIComponent(conversationId)}`;
    const response = await page.request.get(`${dashboard.baseURL}${api}`);
    const report = await response.json();
    report.events = Array.from({ length: 40 }, (_, seq) => ({
      seq,
      createdAt: report.startedAt,
      data: {
        type: "message",
        messageId: `message-${seq}`,
        role: "user",
        text: `Message ${seq}`,
      },
    }));
    report.events.push({
      seq: 40,
      createdAt: report.lastSeenAt,
      data: { type: "message_handled", messageId: "message-39" },
    });
    await page.route(`**${api}*`, (route) =>
      route.fulfill({ json: withRequestedMailbox(route, report) }),
    );
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );
    await expect(
      page.getByText("Message 39", { exact: true }),
    ).toBeInViewport();
    const scroll = page.locator("[data-chat-scroll]");
    await scroll.hover();
    await page.mouse.wheel(0, -10_000);
    await expect(page.getByText("Message 0", { exact: true })).toBeInViewport();

    for (const view of ["Event log", "Conversation"] as const) {
      await chooseTranscriptView(page, view);
      const first =
        view === "Event log"
          ? page.getByRole("button", { name: "Event 0: message", exact: true })
          : page.getByText("Message 0", { exact: true });
      await expect(first).toBeInViewport();
      await expect(
        page.getByRole("button", {
          name: "Jump to latest update",
          exact: true,
        }),
      ).toBeHidden();
    }
    // A later poll can wake an idle conversation while the reader is above the tail.
    report.status = "completed";
    report.events.push({
      seq: 41,
      createdAt: report.lastSeenAt,
      data: {
        type: "message",
        messageId: "idle-message",
        role: "user",
        text: "Idle update",
      },
    });
    await expect(page.getByText("Idle update", { exact: true })).toBeAttached({
      timeout: 15_000,
    });
    await scroll.hover();
    await page.mouse.wheel(0, -10_000);
    await expect(page.getByText("Message 0", { exact: true })).toBeInViewport();
    report.status = "active";
    report.events.push({
      seq: 42,
      createdAt: report.lastSeenAt,
      data: {
        type: "message",
        messageId: "live-message",
        role: "user",
        text: "First live update",
      },
    });
    const liveUpdate = page.getByText("First live update", { exact: true });
    await expect(liveUpdate).toBeAttached({ timeout: 15_000 });
    // New activity must not move a reader who scrolled into history, on either
    // mobile or desktop. Following resumes only when the reader requests it.
    await expect(page.getByText("Message 0", { exact: true })).toBeInViewport();
    const jump = page.getByRole("button", {
      name: "Jump to latest update",
      exact: true,
    });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(liveUpdate).toBeInViewport();
    await expect(jump).toBeHidden();

    report.events.push({
      seq: 43,
      createdAt: report.lastSeenAt,
      data: {
        type: "message",
        messageId: "next-live-message",
        role: "assistant",
        text: "Next live update",
      },
    });
    await expect(
      page.getByText("Next live update", { exact: true }),
    ).toBeInViewport({ timeout: 15_000 });
    await expect(jump).toBeHidden();
  });
}

for (const view of [desktop, mobile]) {
  test(`leads the reader to a new review item question (${view.name})`, async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(view);
    const conversationId = "slack:CQA123:1770003600.000200";
    const api = `/api/conversations/${encodeURIComponent(conversationId)}`;
    const response = await page.request.get(`${dashboard.baseURL}${api}`);
    const report = await response.json();
    const mailbox = await (
      await page.request.get(`${dashboard.baseURL}${api}/pending-messages`)
    ).json();
    const item = {
      addedByConversationId: conversationId,
      assignedToEveryone: false,
      assignees: [
        {
          displayName: "Dashboard User",
          email: "dev@example.com",
          userId: "u-dev",
        },
      ],
      body: "The rollout plan has three open decisions.",
      canAct: true,
      canTake: false,
      conversationIds: [conversationId],
      createdAt: report.startedAt,
      id: "item-tall",
      kind: "action",
      request: {
        question: "How should the payments-v42 rollout go?",
        fields: ["Region", "Window", "Owner"].map((label) => ({
          id: label.toLowerCase(),
          kind: "choice",
          label,
          options: ["First", "Second", "Third", "Fourth"].map((option) => ({
            description: `${option} ${label.toLowerCase()} option for the rollout.`,
            label: `${option} ${label.toLowerCase()}`,
          })),
        })),
      },
      status: "open",
      title: "Plan the payments-v42 rollout",
      updatedAt: report.startedAt,
      visibility: "public",
    };
    let dismissed = false;
    const current = () =>
      dismissed
        ? { ...item, closedAt: report.lastSeenAt, status: "dismissed" }
        : item;
    await page.route(`**/api/review-items/${item.id}`, (route) =>
      route.fulfill({ json: current() }),
    );
    await page.route(`**/api/review-items/${item.id}/actions`, (route) => {
      dismissed = true;
      return route.fulfill({ json: current() });
    });
    // The Conversation also lists the open item above the message box.
    await page.route(`**/api/review-items?*`, (route) =>
      route.fulfill({ json: { items: dismissed ? [] : [item] } }),
    );
    report.events = [
      ...Array.from({ length: 20 }, (_, seq) => ({
        seq,
        createdAt: report.startedAt,
        data: {
          type: "message",
          messageId: `message-${seq}`,
          role: "user",
          text: `Message ${seq}`,
        },
      })),
      {
        seq: 20,
        createdAt: report.lastSeenAt,
        data: {
          type: "tool_calls",
          calls: [
            {
              input: { kind: "action", title: item.title },
              name: "addReviewItem",
              output: JSON.stringify({ item: { id: item.id } }),
              status: "completed",
              toolCallId: "review-1",
            },
          ],
        },
      },
    ];
    // Junior asked and ended its Turn, so it waits for the answer.
    report.status = "completed";
    await page.route(`**${api}*`, (route) =>
      route.fulfill({ json: withRequestedMailbox(route, report, mailbox) }),
    );
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );

    // The reader must see the title and question first, not the end of the form.
    const card = page.getByRole("region", {
      name: `Review item: ${item.title}`,
    });
    await expect(card.getByRole("button", { name: "Send" })).toBeAttached();
    await expect(
      card.getByRole("heading", { name: item.title }),
    ).toBeInViewport();
    // The message box and queued messages hide while Junior waits, so the
    // question is last and the reader does not type the answer as a new
    // message.
    const composer = page.getByLabel("Continue this conversation");
    const queue = page.getByRole("button", { name: /queued messages/ });
    await expect(composer).toBeHidden();
    await expect(queue).toBeHidden();
    await screenshot(page, "conversation-review-item-card", {
      view: view.name,
    });

    // Dismiss closes the item and shows the message box and queue again.
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(composer).toBeVisible();
    await expect(queue).toBeVisible();
    await screenshot(page, "conversation-review-item-dismissed", {
      view: view.name,
    });
  });
}
