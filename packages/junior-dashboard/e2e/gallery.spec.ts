import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows the component gallery index", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev`);
  await expect(
    page.getByRole("heading", { name: "Component gallery", exact: true }),
  ).toBeVisible();
  await screenshot(page, "gallery-index", {
    lightTheme: true,
    view: "desktop",
  });
});

test("shows gallery foundations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/foundations`);
  await expect(
    page.getByRole("heading", { name: "Foundations", exact: true }),
  ).toBeVisible();
  await screenshot(page, "gallery-foundations", {
    lightTheme: true,
    view: "desktop",
  });
  const trigger = page.getByRole("button", { name: "Open shadcn sheet" });
  await trigger.click();
  const sheet = page.getByRole("dialog", {
    name: "Sheet details",
    exact: true,
  });
  await expect(sheet).toBeVisible();
  const close = sheet.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("Tab");
  await expect(
    sheet.getByRole("button", { name: "Primary action" }),
  ).toBeFocused();
  await screenshot(page, "gallery-shadcn-sheet", {
    lightTheme: true,
    target: sheet,
  });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("shows gallery charts", async ({ page, dashboard }) => {
  // Each chart gets a dark and a light image, which takes longer than the
  // default timeout in CI.
  test.slow();
  await page.goto(`${dashboard.baseURL}/dev/charts`);
  await expect(
    page.getByRole("heading", { name: "Charts", exact: true }),
  ).toBeVisible();
  // One image per chart keeps each chart's visual diff separate.
  const charts = page.locator("[data-gallery-chart]");
  await expect(charts.first()).toBeVisible();
  const ids = await charts.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-gallery-chart")!),
  );
  for (const id of ids) {
    await screenshot(page, `gallery-chart-${id}`, {
      lightTheme: true,
      target: page.locator(`[data-gallery-chart="${id}"]`),
    });
  }
});

test("shows gallery transcripts", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/transcripts`);
  await expect(
    page.getByRole("heading", { name: "Transcripts", exact: true }),
  ).toBeVisible();
  const transcript = page.getByLabel("Gallery conversation transcript", {
    exact: true,
  });
  const event = transcript.locator("details").filter({
    has: page.getByText("GitHub PR getsentry/junior#1200 received a review.", {
      exact: true,
    }),
  });
  const rawEvent = event.getByText("The preview is ready for visual review.", {
    exact: true,
  });
  await expect(rawEvent).toBeHidden();
  const heading = event.locator("summary");
  await heading.click();
  await expect(rawEvent).toBeVisible();
  await expect(heading).toBeFocused();
  await heading.press("Enter");
  await expect(rawEvent).toBeHidden();
  await heading.press("Space");
  await expect(rawEvent).toBeVisible();
  await heading.click();
  await screenshot(page, "gallery-transcripts", {
    lightTheme: true,
    view: "desktop",
  });
});
