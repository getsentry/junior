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

test("keeps a created token when a stale list refetch is in flight", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const staleListStarted = promiseSignal();
  const releaseStaleList = promiseSignal();
  let listRequests = 0;
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
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

    listRequests += 1;
    if (listRequests === 2) {
      staleListStarted.resolve();
      await releaseStaleList.promise;
    }
    await route
      .fulfill({
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
      })
      .catch(() => undefined);
  });

  await page.goto(server.baseURL);
  await openPersonalTokens(page);
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "System", exact: true }).click();
  await page.clock.setFixedTime(new Date(Date.now() + 31_000));
  await openPersonalTokens(page);
  await staleListStarted.promise;

  await page.getByLabel("Token name").fill("Review token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  releaseStaleList.resolve();

  await expect(page.getByText("Review token", { exact: true })).toBeVisible();
  expect(listRequests).toBe(2);
  expect(browserErrors).toEqual([]);
});

test("starts only one token create for rapid clicks", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  const releaseCreate = promiseSignal();
  let createRequests = 0;
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      createRequests += 1;
      await releaseCreate.promise;
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

    await route.fulfill({ json: { tokens: [] } });
  });

  await page.goto(server.baseURL);
  await openPersonalTokens(page);
  await page.getByLabel("Token name").fill("Review token");
  await page
    .getByRole("button", { name: "Create token" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect.poll(() => createRequests).toBe(1);
  releaseCreate.resolve();

  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  expect(createRequests).toBe(1);
  expect(browserErrors).toEqual([]);
});

test("keeps cached tokens and mutation errors after a refetch fails", async ({
  page,
}) => {
  const backgroundRefetchFinished = promiseSignal();
  let listRequests = 0;
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 500 });
      return;
    }

    listRequests += 1;
    if (listRequests === 2) {
      await route.fulfill({ status: 500 });
      backgroundRefetchFinished.resolve();
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

  await page.goto(server.baseURL);
  await openPersonalTokens(page);
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "System", exact: true }).click();
  await page.clock.setFixedTime(new Date(Date.now() + 31_000));
  await openPersonalTokens(page);
  await backgroundRefetchFinished.promise;
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();

  await page.getByLabel("Token name").fill("Review token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(
    page.getByText("Could not create the API token. Try again."),
  ).toBeVisible();
  await expect(
    page.getByText("Could not load API tokens. Try again."),
  ).toHaveCount(0);
  expect(listRequests).toBe(2);
});

async function openPersonalTokens(page: Page) {
  await page.getByRole("button", { name: /Open profile menu/ }).click();
  await page.getByRole("link", { name: "API tokens", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Personal API Tokens" }),
  ).toBeVisible();
}

function promiseSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
