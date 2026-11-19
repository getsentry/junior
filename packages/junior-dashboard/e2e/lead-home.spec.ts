import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const LEAD_REPLY =
  "I started both. I'll tell you what the latency investigation finds.";

test("home shows the Lead and the Conversations it started @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(dashboard.baseURL);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);

  // Each started Conversation is a card with its feed status. The Lead
  // watches only the first one.
  const watched = transcript.getByRole("link", {
    name: /Investigate checkout latency/,
  });
  const unwatched = transcript.getByRole("link", {
    name: /Package release and self-update/,
  });
  await expect(watched).toContainText("Watching");
  await expect(unwatched).toBeVisible();
  await expect(unwatched).not.toContainText("Watching");
  await screenshot(page, "lead-home");

  // The Lead is not in the list of Conversations.
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).not.toContainText("Lead");

  // A message from home goes to the Lead, not to a new Conversation.
  const sends: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (/^\/api\/conversations(\/[^/]+\/messages)?$/.test(path)) {
      sends.push(path);
    }
  });
  const reply = page.getByLabel("Continue this conversation");
  await reply.fill("Check the deploy");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(transcript.getByText("Check the deploy")).toBeVisible();
  expect(sends).toEqual([
    expect.stringMatching(
      /^\/api\/conversations\/local%3Aweb%3A[^/]+\/messages$/,
    ),
  ]);

  // A card opens its Conversation. New conversation comes back to the Lead.
  await watched.click();
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(reply).toBeFocused();
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("narrow home sends to the Lead and opens it @classic", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    await page.goto(dashboard.baseURL);
    await expect(
      page.getByRole("list", { name: "Your conversations" }),
    ).toBeVisible();
    const composer = page.getByLabel("Message your Lead");
    // The editor loads after the page. A textarea stands in until then.
    await expect(composer).toHaveAttribute("contenteditable", "true");
    // Return adds a line on a touch screen.
    await composer.fill("First line");
    await composer.press("Enter");
    await composer.pressSequentially("Second line");
    await expect(composer).toHaveText("First line\nSecond line", {
      useInnerText: true,
    });
    await expect(page).toHaveURL(`${dashboard.baseURL}/`);

    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/conversations\/local%3Aweb%3A/);
    const transcript = page.getByLabel("Conversation transcript");
    await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();
    await expect(
      transcript.getByText(/First line\s+Second line/),
    ).toBeVisible();
  });
});
