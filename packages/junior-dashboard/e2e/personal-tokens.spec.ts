import { expect, test, type Page } from "@playwright/test";
import {
  collectBrowserErrors,
  type DashboardE2eServer,
  mockDashboardApis,
  startDashboardE2eServer,
} from "./harness";

let server: DashboardE2eServer;

test.beforeAll(async () => {
  server = await startDashboardE2eServer();
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  await mockDashboardApis(page);
});

test("reuses the personal token list across dashboard routes", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  let listRequests = 0;
  await page.route("**/api/personal-tokens", async (route) => {
    listRequests += 1;
    await route.fulfill({
      json: {
        tokens: [
          {
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-10-30T00:00:00.000Z",
            id: "00000000-0000-4000-8000-000000000001",
            lastUsedAt: null,
            name: "Local agent",
            tokenSuffix: "abcd",
          },
        ],
      },
    });
  });

  await page.goto(server.baseURL);
  await openPersonalTokens(page);
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "System", exact: true }).click();
  await expect(page).toHaveURL(`${server.baseURL}/system`);
  await openPersonalTokens(page);

  expect(listRequests).toBe(1);
  expect(browserErrors).toEqual([]);
});

async function openPersonalTokens(page: Page) {
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "API tokens", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Personal API Tokens" }),
  ).toBeVisible();
}
