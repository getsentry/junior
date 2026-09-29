import { expect, test } from "./test";
import { screenshot } from "./screenshot";

test("shows the component gallery index", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev`);
  await expect(
    page.getByRole("heading", { name: "Component gallery", exact: true }),
  ).toBeVisible();
  await screenshot(page, "gallery-index", { view: "desktop" });
});

test("shows gallery foundations", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/foundations`);
  await expect(
    page.getByRole("heading", { name: "Foundations", exact: true }),
  ).toBeVisible();
  await screenshot(page, "gallery-foundations", { view: "desktop" });
});

test("fades segmented page links that overflow", async ({
  page,
  dashboard,
}) => {
  await page.goto(`${dashboard.baseURL}/dev/foundations`);
  const overflowing = page.getByRole("navigation", {
    name: "System pages, overflowing",
  });
  const scroller = overflowing.locator(":scope > div");
  // More links sit past the right edge, so only that edge fades.
  await expect(scroller).toHaveAttribute("data-overflow-end", "true");
  await expect(scroller).not.toHaveAttribute("data-overflow-start");
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(scroller).toHaveAttribute("data-overflow-start", "true");
  await expect(scroller).not.toHaveAttribute("data-overflow-end");
  // Links that fit do not fade.
  await expect(
    page
      .getByRole("navigation", { name: "Gallery sections", exact: true })
      .locator("[data-overflow-start], [data-overflow-end]"),
  ).toHaveCount(0);
});

test("shows gallery charts", async ({ page, dashboard }) => {
  await page.goto(`${dashboard.baseURL}/dev/charts`);
  await expect(
    page.getByRole("heading", { name: "Charts", exact: true }),
  ).toBeVisible();
  await screenshot(page, "gallery-charts", { view: "desktop" });
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
  await screenshot(page, "gallery-transcripts", { view: "desktop" });
});
