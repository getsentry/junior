import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { mockDashboardApis } from "./harness";
import { screenshot } from "./screenshot";

async function openAsAdmin(page: Page) {
  await mockDashboardApis(page);
  // The page shell embeds the viewer, so make that viewer an admin too.
  await page.addInitScript(() => {
    let bootstrap: { me?: { user?: { isAdmin?: boolean } } } | undefined;
    Object.defineProperty(window, "__JUNIOR_DASHBOARD_BOOTSTRAP__", {
      configurable: true,
      get: () => bootstrap,
      set: (value) => {
        if (value?.me?.user) value.me.user.isAdmin = true;
        bootstrap = value;
      },
    });
  });
  await page.route("**/api/service-accounts", async (route) => {
    await route.fulfill({ json: { serviceAccounts: [] } });
  });
}

test("lets an admin turn cache warming back on after the breaker opens", async ({
  page,
  dashboard,
}) => {
  await openAsAdmin(page);
  let anthropicOpen = true;
  const closed: string[] = [];
  await page.route("**/api/cache-warming/breakers", async (route) => {
    await route.fulfill({
      json: {
        breakers: [{ provider: "anthropic", open: anthropicOpen }],
      },
    });
  });
  await page.route("**/api/cache-warming/breakers/*", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    closed.push(new URL(route.request().url()).pathname.split("/").at(-1)!);
    anthropicOpen = false;
    await route.fulfill({ json: { closed: true } });
  });

  await page.goto(`${dashboard.baseURL}/admin`);
  const section = page.locator("section", {
    has: page.getByRole("heading", { name: "Cache warming" }),
  });
  await expect(section.getByText("paused", { exact: true })).toBeVisible();
  await screenshot(page, "admin-cache-warming", { view: "desktop" });
  await screenshot(page, "admin-cache-warming", { view: "mobile" });

  await section
    .getByRole("button", { name: "Turn anthropic cache warming back on" })
    .click();
  await expect(section.getByText("paused", { exact: true })).toBeHidden();
  await expect(section.getByText("on", { exact: true })).toBeVisible();
  await screenshot(page, "admin-cache-warming-on", { view: "desktop" });
  expect(closed).toEqual(["anthropic"]);
});

test("lets an admin keep agent model calls on chosen providers", async ({
  page,
  dashboard,
}) => {
  await openAsAdmin(page);
  let enabled: string[] | null = null;
  const saved: Array<string[] | null> = [];
  await page.route("**/api/gateway-providers", async (route) => {
    if (route.request().method() === "PUT") {
      enabled = (route.request().postDataJSON() as { enabled: string[] | null })
        .enabled;
      saved.push(enabled);
    }
    await route.fulfill({
      json: {
        enabled,
        providers: [
          "anthropic",
          "azure",
          "bedrock",
          "claudeaws",
          "openai",
          "vertex",
        ],
        models: [
          {
            id: "anthropic/claude-opus-5.5",
            providers: ["anthropic", "bedrock", "claudeaws", "vertex"],
          },
          { id: "openai/gpt-6-astra", providers: ["azure", "openai"] },
        ],
      },
    });
  });

  await page.goto(`${dashboard.baseURL}/admin`);
  // The page section contains the card section, so take the innermost.
  const section = page
    .locator("section", {
      has: page.getByRole("heading", { name: "Enabled providers" }),
    })
    .last();
  const routes = section.getByRole("definition");
  await expect(routes.first()).toHaveText("Any provider");
  for (const provider of ["bedrock", "claudeaws", "vertex"]) {
    await section.getByRole("checkbox", { name: provider }).click();
  }
  await expect(routes.first()).toHaveText("anthropic");
  // No checked provider serves this model, so it stays unfiltered.
  await expect(routes.nth(1)).toHaveText("Any provider");
  await screenshot(page, "admin-enabled-providers", { target: section });

  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(saved).toEqual([["anthropic", "azure", "openai"]]);
});
