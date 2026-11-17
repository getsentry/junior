import { LIST_NOW, automationReport } from "./automation-fixture";
import { mockAutomationCollection } from "../../src/mock-reporting/automation-collection";
import { expect, test } from "../test";
import { screenshot } from "../screenshot";

// Only the inbox project runs `@new` tests.
test.describe("new UI", { tag: "@new" }, () => {
  test("pages the Automations list as it scrolls and expands a row in place", async ({
    page,
    dashboard,
  }) => {
    await page.clock.setFixedTime(LIST_NOW);
    const weekly = automationReport.automations[0]!;
    const collection = {
      ...automationReport,
      automations: [
        ...automationReport.automations,
        // Older runs than the fixtures, so they list after them.
        ...Array.from({ length: 117 }, (_, index) => ({
          ...weekly,
          id: `scheduled-extra-${index}`,
          lastRunAt: new Date(
            LIST_NOW.getTime() - (index + 30) * 3_600_000,
          ).toISOString(),
          title: `Weekly summary ${String(index).padStart(3, "0")}`,
        })),
      ],
    };
    const requests: URLSearchParams[] = [];
    await page.route(/\/api\/automations(?:\?.*)?$/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      // To do reads the viewer's attention list from the same route.
      if (params.get("sort") === "activity") requests.push(params);
      return route.fulfill({
        json: mockAutomationCollection(collection, params),
      });
    });
    await page.goto(`${dashboard.baseURL}/automations`);
    const main = page.getByRole("main");
    const rows = main.getByRole("link", { name: /^Open automation: / });
    // One page first, newest activity first, for the viewer's own.
    await expect(rows).toHaveCount(50);
    expect(Object.fromEntries(requests[0]!)).toMatchObject({
      pageSize: "50",
      scope: "mine",
      sort: "activity",
    });
    expect(requests[0]!.has("cursor")).toBe(false);
    await expect(rows.first()).toHaveText("Weekly project summary");
    // The end of the list loads the next page on its cursor.
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(100);
    expect(requests.at(-1)!.get("cursor")).toBe("50");
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(119);
    await expect(rows.last()).toHaveText("Weekly summary 116");
    await expect(main.getByRole("status")).toHaveCount(0);

    // A click on the card opens it in place, as an Inbox row does.
    await rows.first().scrollIntoViewIfNeeded();
    const card = main.locator('[data-automation-id="scheduled-1"]');
    const details = main.getByRole("region", {
      name: "Weekly project summary: details",
    });
    const toggle = main.getByRole("button", {
      name: "Details: Weekly project summary",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await card.getByText(weekly.destination.label, { exact: true }).click();
    await expect(card).toHaveAttribute("data-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(details).toContainText("Schedule");
    await expect(details).toContainText("Next run");
    // The owner's avatar shows an initial before the name.
    await expect(details).toContainText(
      new RegExp(`Owner.*You.*Destination${weekly.destination.label}`),
    );
    await expect(
      details
        .getByRole("list", { name: "Last runs of Weekly project summary" })
        .getByRole("listitem"),
    ).toHaveCount(Math.min(5, weekly.recentRuns.length));
    await expect(
      details.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect(
      details.getByRole("link", { name: "Open automation", exact: true }),
    ).toHaveAttribute("href", "/automations/scheduled-1");
    await screenshot(page, "automations-expanded-row", { lightTheme: true });
    // Only one card is open at a time.
    await main
      .getByRole("button", { name: "Details: Closed issue summary" })
      .click();
    await expect(details).toHaveCount(0);
    await expect(
      main.getByRole("region", { name: "Closed issue summary: details" }),
    ).toBeVisible();
    // The keyboard opens and closes a card from its Details button.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(details).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(details).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
