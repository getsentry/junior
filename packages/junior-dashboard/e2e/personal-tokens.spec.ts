import { expect, test } from "@playwright/test";
import {
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

test("lists and creates personal API tokens from settings", async ({
  page,
}) => {
  let createRequests = 0;
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      createRequests += 1;
      await route.fulfill({
        json: {
          createdAt: "2026-08-01T00:01:00.000Z",
          expiresAt: "2026-10-30T00:01:00.000Z",
          id: "00000000-0000-4000-8000-000000000002",
          lastUsedAt: null,
          name: "Review token",
          token: "jr_pat_one-time-secret",
          tokenSuffix: "wxyz",
        },
      });
      return;
    }

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

  await page.goto(`${server.baseURL}/settings/api-tokens`);
  await expect(
    page.getByRole("heading", { name: "Personal API Tokens" }),
  ).toBeVisible();
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();

  await page.getByLabel("Token name").fill("Review token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  await expect(page.getByText("Review token", { exact: true })).toBeVisible();
  expect(createRequests).toBe(1);
});

test("surfaces token create errors without losing the list", async ({
  page,
}) => {
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500 });
      return;
    }

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

  await page.goto(`${server.baseURL}/settings/api-tokens`);
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();
  await page.getByLabel("Token name").fill("Review token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(
    page.getByText("Could not create the API token. Try again."),
  ).toBeVisible();
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();
});
