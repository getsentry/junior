import { expect, test } from "./test";
import { captureDashboardScreenshot, DESKTOP } from "./screenshot";

test("shows the component gallery index", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev`);
  await expect(
    page.getByRole("heading", { name: "Component gallery", exact: true }),
  ).toBeVisible();
  await captureDashboardScreenshot(page, "gallery-index", {
    viewport: DESKTOP,
  });
});

test("shows gallery foundations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/foundations`);
  await expect(
    page.getByRole("heading", { name: "Foundations", exact: true }),
  ).toBeVisible();
  await captureDashboardScreenshot(page, "gallery-foundations", {
    viewport: DESKTOP,
  });
});

test("shows gallery charts", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/charts`);
  await expect(
    page.getByRole("heading", { name: "Charts", exact: true }),
  ).toBeVisible();
  await captureDashboardScreenshot(page, "gallery-charts", {
    viewport: DESKTOP,
  });
});

test("shows gallery transcripts", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/transcripts`);
  await expect(
    page.getByRole("heading", { name: "Transcripts", exact: true }),
  ).toBeVisible();
  await captureDashboardScreenshot(page, "gallery-transcripts", {
    viewport: DESKTOP,
  });
});
