import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("lists and creates personal API tokens from settings", async ({
  context,
  page,
  dashboard,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: dashboard.baseURL,
  });
  const createdNames: string[] = [];
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      createdNames.push(route.request().postDataJSON().name);
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

  await page.goto(
    `${dashboard.baseURL}/settings/api-tokens?name=${encodeURIComponent("Review token")}`,
  );
  await expect(
    page.getByRole("heading", { name: "API Tokens", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Token name")).toHaveValue("Review token");
  await screenshot(page, "settings-api-tokens", { view: "desktop" });

  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  await expect(page.getByText("Copied to your clipboard.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "jr_pat_one-time-secret",
  );
  await expect(page.getByText("Review token", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy token" })).toBeVisible();
  await screenshot(page, "settings-api-tokens-created", { view: "desktop" });

  // A blank name gets the creation time instead of a shared default.
  await page.getByRole("button", { name: "Create another token" }).click();
  await expect(page.getByLabel("Token name")).toHaveValue("");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  expect(createdNames).toEqual([
    "Review token",
    expect.stringMatching(/^Token from /),
  ]);
});

test("shows a new token when the browser has no Clipboard API", async ({
  page,
  dashboard,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
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
    await route.fulfill({ json: { tokens: [] } });
  });

  await page.goto(`${dashboard.baseURL}/settings/api-tokens`);
  await page.getByLabel("Token name").fill("Review token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("jr_pat_one-time-secret")).toBeVisible();
  await expect(
    page.getByText("Copy this token now. It won't be shown again."),
  ).toBeVisible();
  await expect(page.getByText("Review token", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Could not create the API token. Try again."),
  ).toHaveCount(0);
});

test("surfaces token create errors without losing the list", async ({
  page,
  dashboard,
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

  await page.goto(`${dashboard.baseURL}/settings/api-tokens`);
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();
  await page.getByLabel("Token name").fill("Review token");
  await page.getByLabel("Token name").press("ControlOrMeta+Enter");
  await expect(
    page.getByText("Could not create the API token. Try again."),
  ).toBeVisible();
  await expect(page.getByText("Local agent", { exact: true })).toBeVisible();
});

test("sends a new token to a Preview that Junior made for the viewer", async ({
  page,
  dashboard,
}) => {
  const previewOrigin = "https://sb-e2e.vercel.run";
  const createBodies: unknown[] = [];
  let previewForm = "";
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      createBodies.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          createdAt: "2026-08-01T00:01:00.000Z",
          expiresAt: "2026-10-30T00:01:00.000Z",
          id: "00000000-0000-4000-8000-000000000003",
          lastUsedAt: null,
          name: "Live preview on sb-e2e.vercel.run",
          token: "jr_pat_preview-secret",
          tokenSuffix: "secret",
        },
      });
      return;
    }
    await route.fulfill({ json: { tokens: [] } });
  });
  await page.route(`${previewOrigin}/**`, async (route) => {
    previewForm = route.request().postData() ?? "";
    await route.fulfill({ body: "<p>Preview</p>", contentType: "text/html" });
  });

  await page.goto(
    `${dashboard.baseURL}/settings/api-tokens?preview=${encodeURIComponent(previewOrigin)}`,
  );
  await expect(
    page.getByText("Send a read-only token to sb-e2e.vercel.run?"),
  ).toBeVisible();
  await screenshot(page, "settings-api-tokens-preview-handoff", {
    view: "desktop",
  });

  await page.getByRole("button", { name: "Send token" }).click();
  await expect(page).toHaveURL(`${previewOrigin}/?live`);
  expect(createBodies).toEqual([
    { name: "Live preview on sb-e2e.vercel.run", previewOrigin },
  ]);
  expect(new URLSearchParams(previewForm).get("token")).toBe(
    "jr_pat_preview-secret",
  );
});

test("explains when Junior did not make the Preview", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/personal-tokens", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        json: { error: "Junior did not make this Preview for you." },
        status: 403,
      });
      return;
    }
    await route.fulfill({ json: { tokens: [] } });
  });

  await page.goto(
    `${dashboard.baseURL}/settings/api-tokens?preview=${encodeURIComponent("https://sb-other.vercel.run")}`,
  );
  await page.getByRole("button", { name: "Send token" }).click();
  await expect(
    page.getByText("did not make sb-other.vercel.run for you."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Token name")).toBeVisible();
});
