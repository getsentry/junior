import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("inspects all reporting events and searches full event data", async ({
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
  await page.getByRole("button", { name: "Event log", exact: true }).click();
  const log = page.getByRole("region", { name: "Conversation event log" });
  const entries = log.getByRole("button");
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
    name: "Event 3: turn_routed",
    exact: true,
  });
  await entry.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "turn_routed", exact: true });
  await expect(panel.getByText("Model profile", { exact: true })).toBeVisible();
  await expect(panel.getByText("handoff", { exact: true })).toBeVisible();
  await expect(panel.locator("pre")).toBeHidden();
  const close = panel.getByRole("button", { name: "Close event details" });
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.locator("summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await screenshot(page, "conversation-event-details");
  await panel.getByText("Raw JSON", { exact: true }).click();
  await expect(panel.locator("pre")).toHaveText(
    JSON.stringify(
      report.events.find((event: { seq: number }) => event.seq === 3),
      null,
      2,
    ),
  );
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(entry).toBeFocused();

  await page.getByRole("button", { name: "Search transcript" }).click();
  const search = page.getByPlaceholder("Search transcript…");
  await search.fill("memory-checkout-runbook");
  await expect(entries).toHaveCount(1);
  await expect(entries).toHaveAttribute("aria-label", "Event 2: turn_context");
  await search.fill("no-such-event-data");
  await expect(log.getByText("No events match your search.")).toBeVisible();
  await search.fill("");
  await expect(entries).toHaveCount(report.events.length);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(log).toBeHidden();
  await expect(
    page.getByText(
      "Find the slow checkout requests from the last deployment.",
      { exact: true },
    ),
  ).toBeVisible();

  // Both views use the same cutoff and retry-safe create request.
  const forkAction = page
    .getByRole("button", { name: "Fork after this message" })
    .last();
  await forkAction.click();
  const forkDialog = page.getByRole("dialog", {
    name: "Fork Conversation",
    exact: true,
  });
  await expect(
    forkDialog.getByText(/Sandbox files and active work are not copied/),
  ).toBeVisible();
  await screenshot(page, "conversation-fork-dialog");
  await forkDialog.getByRole("button", { name: "Close fork dialog" }).click();
  await page.getByRole("button", { name: "Event log", exact: true }).click();
  const reply = report.events.findLast(
    (event: { data: { type: string; role?: string } }) =>
      event.data.type === "message" && event.data.role === "assistant",
  );
  await log
    .getByRole("button", { name: `Event ${reply.seq}: message`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "message", exact: true })
    .getByRole("button", { name: "Fork after this message" })
    .click();
  const requests: Array<{
    cutoff: { kind: string; messageId: string };
    idempotencyKey: string;
  }> = [];
  const forkId = "local:web:fork-browser-test";
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
          : {
              json: {
                conversationId: forkId,
                sourceConversationId: conversationId,
                throughSeq: reply.seq,
                sourceMessageId: reply.data.messageId,
                status: "created",
              },
            },
      );
    },
  );
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}`,
    (route) =>
      route.fulfill({
        json: {
          ...report,
          conversationId: forkId,
          forkedFromConversationId: conversationId,
          events: [],
          isParticipant: true,
          status: "completed",
          forks: [],
        },
      }),
  );
  const pendingResponse = await page.request.get(
    `${dashboard.baseURL}/api/conversations/${encodeURIComponent(conversationId)}/pending-messages`,
  );
  const pending = await pendingResponse.json();
  await page.route(
    `**/api/conversations/${encodeURIComponent(forkId)}/pending-messages`,
    (route) =>
      route.fulfill({
        json: { ...pending, conversationId: forkId, messages: [] },
      }),
  );
  await forkDialog
    .getByRole("button", { name: "Create fork", exact: true })
    .click();
  await expect(forkDialog.getByRole("alert")).toHaveText(
    "Could not create the fork. Try again.",
  );
  await forkDialog
    .getByRole("button", { name: "Create fork", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(forkId)));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.cutoff).toEqual({
    kind: "message",
    messageId: reply.data.messageId,
  });
  await expect(
    page.getByRole("link", { name: "Forked from source conversation" }),
  ).toBeVisible();
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

  const loadEarlier = page.getByRole("button", {
    name: "Load earlier events",
  });
  await expect(loadEarlier).toBeVisible();
  await page.getByRole("button", { name: "Event log", exact: true }).click();
  await expect(
    page.getByText("Show earlier events", { exact: true }),
  ).toBeVisible();
  await loadEarlier.click();
  await expect(loadEarlier).toHaveCount(0);
  const log = page.getByRole("region", { name: "Conversation event log" });
  await expect(
    log.getByRole("button", { name: "Event 2: tool_calls", exact: true }),
  ).toContainText("bash · running");
  await expect(
    log.getByRole("button", { name: "Event 3: tool_calls", exact: true }),
  ).toContainText("bash · completed");
  await expect(log.getByText(/Released the package/)).toBeVisible();
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
    await page.route(`**${api}`, (route) => route.fulfill({ json: report }));
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
    );
    await expect(page.getByText("Message 39", { exact: true })).toBeVisible();
    const scroll = page.locator("[data-chat-scroll]");
    await scroll.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(page.getByText("Message 0", { exact: true })).toBeInViewport();

    for (const view of ["Event log", "Conversation"]) {
      if (width < 768)
        await page.getByRole("button", { name: "Conversation menu" }).click();
      await page.getByRole("button", { name: view, exact: true }).click();
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
    await scroll.evaluate((node) => {
      node.scrollTop = 0;
    });
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
    if (width < 768) {
      await expect(liveUpdate).toBeInViewport();
    } else {
      await expect(
        page.getByText("Message 0", { exact: true }),
      ).toBeInViewport();
      await expect(
        page.getByRole("button", {
          name: "Jump to latest update",
          exact: true,
        }),
      ).toBeVisible();
    }
  });
}
