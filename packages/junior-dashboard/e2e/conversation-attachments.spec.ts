import { expect, test } from "./test";
import { screenshot } from "./screenshot";

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
  // A pending file has no bytes yet, so it shows as a file row, not a video.
  const recording = page.getByRole("button", {
    name: "Download standup-recording.mp4",
  });
  await recording.scrollIntoViewIfNeeded();
  await expect(page.getByText("Too large to preview")).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: /standup-recording/ }),
  ).toHaveCount(0);

  const download = page.waitForEvent("download");
  await recording.click();
  await expect(page.getByText("Preparing download…")).toBeVisible();
  await expect(recording).toBeDisabled();
  expect((await download).suggestedFilename()).toBe("standup-recording.mp4");
  await expect(recording).toBeEnabled();

  await page
    .getByRole("button", { name: "Download deleted-recording.mov" })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "deleted-recording.mov" }),
  ).toHaveText(
    "deleted-recording.mov is no longer available: The Slack file was deleted, or Junior can no longer access it.",
  );
  await screenshot(page, "conversation-pending-attachment");
});
