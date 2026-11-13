import { expect, test } from "./test";
import { mockDashboardApis } from "./harness";
import { screenshot } from "./screenshot";

test("lets an admin turn cache warming back on after the breaker opens", async ({
  page,
  dashboard,
}) => {
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
  let anthropicOpen = true;
  const closed: string[] = [];
  await page.route("**/api/cache-warming/breakers", async (route) => {
    await route.fulfill({
      json: {
        breakers: [
          { provider: "anthropic", open: anthropicOpen },
          { provider: "alibaba", open: false },
          { provider: "openai", open: false },
        ],
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
  expect(closed).toEqual(["anthropic"]);
});
