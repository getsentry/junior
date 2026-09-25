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
  await expect(panel.locator("pre")).toHaveCount(0);
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
});

test("loads earlier events without merging tool starts and results", async ({
  page,
  dashboard,
}) => {
  // Deeper history/cursor contracts live in dashboard-mock-routes + transcript
  // bottom-pinning unit coverage. Keep one browser smoke on the mock surface.
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
