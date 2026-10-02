import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("filters gap observations, reviews one, and opens its evidence", async ({
  page,
  dashboard,
}) => {
  const id = "a".repeat(64);
  let state = "Unreviewed";
  await page.route("**/api/user-pages", async (route) => {
    await route.fulfill({
      json: [
        {
          id: "gaps",
          label: "Gaps",
          description:
            "Observed limitations, not permanent facts. Private observations stay private. Only the owner can review an observation.",
          navigation: "primary",
          pluginName: "memory",
          pluginDisplayName: "Memory",
        },
      ],
    });
  });
  await page.route("**/api/user-pages/memory/gaps*", async (route) => {
    await route.fulfill({
      json: {
        type: "list",
        searchPlaceholder: "Search gap observations",
        filters: [
          { label: "All observations", value: "" },
          { label: "Impact: Blocked", value: "impact:blocked" },
        ],
        metrics: [
          "Data or knowledge",
          "Tool capability",
          "Permission",
          "Tool failure",
        ].map((label) => ({
          label,
          value: label === "Permission" ? "1" : "0",
          detail:
            "Distinct affected Turns matching the filter, not grouped gap frequency.",
        })),
        records: [
          {
            id,
            title: "Cannot read deployment status",
            href: "/conversations/gap-example",
            description:
              "The status lookup returned a permission error and the request stayed blocked.",
            metadata: [
              { label: "Category", value: "Permission" },
              { label: "Impact", value: "Blocked" },
              { label: "Review", value: state },
              {
                label: "Evidence",
                value: "Tool cited; not yet proof of root cause",
              },
              { label: "Visibility", value: "Private" },
              { label: "Observed (UTC)", value: "2026-09-24T19:00:00.000Z" },
              { label: "Turn", value: "1d5a8972-1812-4204-91d2-fbbd52dbb631" },
            ],
            actions:
              state === "Unreviewed"
                ? [
                    {
                      label: "Confirm",
                      href: `/api/plugins/memory/gaps/${id}/confirmed`,
                      method: "POST",
                      tone: "neutral",
                    },
                    {
                      label: "Dismiss",
                      href: `/api/plugins/memory/gaps/${id}/dismissed`,
                      method: "POST",
                      tone: "neutral",
                    },
                  ]
                : [],
          },
        ],
      },
    });
  });
  await page.route(
    `**/api/plugins/memory/gaps/${id}/confirmed`,
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().headers()["content-type"]).toBe(
        "application/json",
      );
      state = "Confirmed";
      await route.fulfill({ json: { ok: true } });
    },
  );
  await page.goto(dashboard.baseURL);
  await page.getByRole("link", { name: "Gaps", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Gaps", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter records").selectOption("impact:blocked");
  await expect(page).toHaveURL(/filter=impact%3Ablocked/);
  await expect(
    page.getByRole("link", { name: "Cannot read deployment status" }),
  ).toBeVisible();
  await screenshot(page, "gap-log");
  await page
    .getByRole("button", { name: "Confirm: Cannot read deployment status" })
    .click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Confirm: Cannot read deployment status",
    }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Cannot read deployment status" })
    .click();
  await expect(page).toHaveURL(
    `${dashboard.baseURL}/conversations/gap-example`,
  );
});
