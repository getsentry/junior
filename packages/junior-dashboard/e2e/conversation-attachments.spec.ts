import { readFile } from "node:fs/promises";
import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";

test("previews text attachments in a drawer", async ({ page, dashboard }) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    { waitUntil: "networkidle" },
  );
  // The server sends text files as downloads. The dashboard reads and
  // renders them itself.
  const readme = page.getByRole("button", { name: /README\.md/ });
  await readme.scrollIntoViewIfNeeded();
  await readme.click();
  const preview = page.getByRole("dialog", { name: "README.md" });
  await expect(
    preview.getByRole("heading", { name: "Release notes" }),
  ).toBeVisible();
  // A newline in a Markdown file paragraph does not break the line.
  await expect(
    preview.getByText("This line wraps in the source."),
  ).toBeVisible();
  // A reference link after a fence still resolves.
  await expect(preview.getByRole("link", { name: "docs" })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  );
  await expect(
    preview.getByRole("link", { name: "Download README.md" }),
  ).toHaveAttribute("download", "README.md");
  await screenshot(page, "conversation-text-attachment", { lightTheme: true });

  await preview.getByRole("button", { name: "Raw" }).click();
  await expect(preview.getByText("# Release notes")).toBeVisible();
  await screenshot(page, "conversation-text-attachment-raw", {
    view: "desktop",
  });
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();

  await page.getByRole("button", { name: /notes\.txt/ }).click();
  const notes = page.getByRole("dialog", { name: "notes.txt" });
  await expect(notes.getByText("mock attachment notes")).toBeVisible();
  // Plain text has no Markdown view to pick.
  await expect(notes.getByRole("button", { name: "Raw" })).toHaveCount(0);
});

test("downloads a large Slack file on request", async ({ page, dashboard }) => {
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    { waitUntil: "networkidle" },
  );
  // Junior has not stored this large Slack file yet, so it shows as a file
  // row with no preview, not a video.
  const recording = page.getByRole("button", {
    name: "Download standup-recording.mp4",
  });
  await recording.scrollIntoViewIfNeeded();
  await expect(page.getByText("Too large to preview")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: /standup-recording/ }),
  ).toHaveCount(0);

  const conversationUrl = page.url();
  const download = page.waitForEvent("download");
  await recording.click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("standup-recording.mp4");
  // The byte route must send the video as an attachment, or some browsers
  // replace the conversation with it.
  expect(saved.url()).toMatch(/\?download=true$/);
  expect(page.url()).toBe(conversationUrl);
  const streamed = await readFile(await saved.path());
  const expected = await (await page.request.get(saved.url())).body();
  expect(streamed.byteLength).toBeGreaterThan(0);
  expect(streamed.equals(expected)).toBe(true);
  await expect(recording).toBeEnabled();

  await page
    .getByRole("button", { name: "Download deleted-recording.mov" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "deleted-recording.mov" }),
  ).toHaveText(
    "deleted-recording.mov is no longer available: The Slack file was deleted, or this app can no longer access it.",
  );
  // The failed download loaded in the hidden frame, not over the page.
  expect(page.url()).toBe(conversationUrl);
  await screenshot(page, "conversation-pending-attachment");
});

test("previews conversation images and pages through them", async ({
  page,
  dashboard,
}) => {
  // The previews open on a phone, then each view takes its own shot.
  await page.setViewportSize(mobile);
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    { waitUntil: "networkidle" },
  );
  await expect(
    page.getByRole("heading", {
      name: "Dashboard QA edge cases",
      exact: true,
    }),
  ).toBeVisible();
  const inputImage = page.getByRole("img", { name: "input-chart.png" });
  await inputImage.scrollIntoViewIfNeeded();
  await expect(inputImage).toBeVisible();
  await inputImage.click();
  const inputPreview = page.getByRole("dialog", { name: "input-chart.png" });
  await expect(inputPreview).toBeVisible();
  // The sent image is not part of the response, so it has no pager.
  await expect(
    inputPreview.getByRole("button", { name: "Next image" }),
  ).toHaveCount(0);
  await inputPreview
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const image = page
    .locator('a[href*="/attachments/qa-chart-png"]')
    .filter({ has: page.locator('img[alt="chart.png"]') })
    .first();
  await image.waitFor({ state: "visible" });
  // A resize keeps another scroll position, so center the image in each view.
  for (const view of [desktop, mobile]) {
    await page.setViewportSize(view);
    await image.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    await screenshot(page, "conversation-attachment", { view: view.name });
  }

  await image.click();
  const preview = page.getByRole("dialog", { name: "chart.png" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("1 of 2")).toBeVisible();
  await screenshot(page, "conversation-attachment-modal");
  // The preview pages through the images of one response.
  await preview.getByRole("button", { name: "Next image" }).click();
  const detailPreview = page.getByRole("dialog", { name: "chart-detail.png" });
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(preview.getByText("1 of 2")).toBeVisible();

  // Touch readers swipe to page and dismiss, and pinch to zoom. Real touch
  // input checks that the frame keeps a gesture after a finger leaves it.
  await page.setViewportSize(mobile);
  const touch = await page.context().newCDPSession(page);
  const pinch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: { id: number; x: number; y: number }[],
  ) => touch.send("Input.dispatchTouchEvent", { touchPoints: points, type });
  const swipe = async (
    from: { x: number; y: number },
    dx: number,
    dy: number,
  ) => {
    await pinch("touchStart", [{ id: 1, ...from }]);
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await pinch("touchMove", [
        { id: 1, x: from.x + dx * step, y: from.y + dy * step },
      ]);
    }
    await pinch("touchEnd", []);
  };
  await swipe({ x: 300, y: 450 }, -200, 0);
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await swipe({ x: 100, y: 450 }, 200, 0);
  await expect(preview.getByText("1 of 2")).toBeVisible();
  // A short swipe springs back, so the preview still pages.
  await swipe({ x: 200, y: 300 }, 0, 30);
  await page.keyboard.press("ArrowRight");
  await expect(detailPreview.getByText("2 of 2")).toBeVisible();
  await swipe({ x: 200, y: 300 }, 0, 250);
  await expect(detailPreview).toBeHidden();

  await image.click();
  await expect(preview.getByText("1 of 2")).toBeVisible();
  // The preview shows at 95% scale until its first frame ends. A pinch that
  // starts then measures the image there and zooms it a few pixels off.
  await expect(preview).not.toHaveAttribute("data-starting-style");
  await pinch("touchStart", [
    { id: 1, x: 180, y: 450 },
    { id: 2, x: 210, y: 450 },
  ]);
  await pinch("touchMove", [
    { id: 1, x: 120, y: 450 },
    { id: 2, x: 300, y: 700 },
  ]);
  await pinch("touchEnd", []);
  await touch.detach();
  await screenshot(page, "conversation-attachment-zoom");
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
});
