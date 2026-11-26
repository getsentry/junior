import { NOW_MS } from "../src/mock-reporting/fixtures";
import { expectRequestBudget } from "./request-budget";
import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const BILLING_ID = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";
const BILLING = `/spaces/${BILLING_ID}`;
const MOBILE_APP = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a22";
const DOCS = "/spaces/6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a23";

const LEAD_REPLY =
  "Started both and watching them. I'll report back here when one needs you or finishes.";

test("a Space page shows its Lead and the Conversations it started", async ({
  page,
  dashboard,
}) => {
  // The fixture Conversations finished "today" at fixture time.
  await page.clock.setFixedTime(NOW_MS);
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${BILLING}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Billing migration" }),
  ).toBeVisible();
  // Members share the Lead: another member's request is in it too.
  await expect(transcript.getByText("Avery Chen")).toBeVisible();
  await expect(
    transcript.getByRole("separator", { name: "Today" }),
  ).toBeVisible();

  // Each started Conversation is a card with its state, summary, and Watch.
  const needsYou = transcript.getByRole("article", {
    name: "Triage Sentaur GoCD deployment failures",
  });
  const failed = transcript.getByRole("article", {
    name: "Deployment investigation failed",
  });
  const working = transcript.getByRole("article", {
    name: "Investigate checkout latency",
  });
  const done = transcript.getByRole("article", {
    name: "Checkout latency triage",
  });
  await expect(needsYou).toContainText("Needs you");
  await expect(needsYou).toContainText("Watching");
  await expect(
    needsYou.getByRole("link", { name: "Open to approve" }),
  ).toBeVisible();
  await expect(failed).toContainText("Failed");
  await expect(failed).not.toContainText("Watching");
  await expect(failed.getByRole("link", { name: "Open" })).toBeVisible();
  await expect(working).toContainText("Working");
  await expect(working).toContainText("Watching");
  await expect(working.getByRole("button", { name: "Message it" })).toHaveCount(
    0,
  );
  await expect(done).toContainText("Done");

  // Routine Watch Events fold into one row. The ones that need a person
  // show as one line each, before the Lead's reply.
  await expect(
    transcript.getByText("Investigate checkout latency finished").first(),
  ).toBeHidden();
  await expect(
    transcript.getByText("Triage Sentaur GoCD deployment failures needs you"),
  ).toBeVisible();
  await expect(
    transcript.getByText("Deployment investigation failed failed"),
  ).toBeVisible();
  await expect(
    page.getByText("Ask the Lead to start, find, or check on work…"),
  ).toBeVisible();

  // The Space's details sit beside the Lead: its Threads and members.
  const details = page.getByRole("complementary", { name: "Space details" });
  await details.getByRole("button", { name: "Done · 2" }).click();
  await expect(
    details.getByRole("link", { name: /Plan the billing migration/ }),
  ).toBeVisible();
  await expect(details.getByText("Avery Chen")).toBeVisible();
  await screenshot(page, "space-lead-reports");
  await working.scrollIntoViewIfNeeded();
  await screenshot(page, "space-lead");

  // The folded row opens in place to the routine updates.
  await transcript.getByRole("button", { name: /^2 routine updates/ }).click();
  await expect(
    transcript.getByText("Investigate checkout latency finished"),
  ).toHaveCount(2);
  await expect(
    transcript.getByText("Investigate checkout latency finished").first(),
  ).toBeVisible();

  // A message from the page goes to the Lead, not to a new Conversation.
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

  // "Message it" puts a reference to the card's Conversation in the reply.
  await failed.getByRole("button", { name: "Message it" }).click();
  await expect(reply).toContainText("Deployment investigation failed");

  // A card opens its Conversation.
  await working
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
});

test("loads a Space page within its request budget", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await expectRequestBudget(
    page,
    async () => {
      await page.goto(`${dashboard.baseURL}${BILLING}`);
      await expect(
        page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
      ).toBeVisible();
    },
    // The Space's Threads are the Lead's child agents, one more read.
    { requests: 15, serialRounds: 3 },
  );
});

test("the Lead's own link keeps its Space's header", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const lead = await page.request.get(
    `${dashboard.baseURL}/api/spaces/${BILLING_ID}/lead`,
  );
  const { conversationId } = (await lead.json()) as { conversationId: string };
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(conversationId)}`,
  );
  await expect(
    page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Billing migration" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Conversation menu" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Space details" }),
  ).toBeVisible();
});

test("home opens the Inbox, and the pane has no Lead", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(dashboard.baseURL);
  await expect(page).toHaveURL(`${dashboard.baseURL}/inbox`);
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(
    primary.getByRole("link", { name: /^Inbox, \d+ waiting$/ }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    primary.getByRole("link", { name: "Lead", exact: true }),
  ).toHaveCount(0);
});

test("a new Lead introduces itself", async ({ page, dashboard }) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${MOBILE_APP}`);
  await expect(
    page.getByRole("heading", { name: "This Space's Lead" }),
  ).toBeVisible();
  for (const title of ["Starts work", "Keeps watch", "Finds and steers"]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  const reply = page.getByLabel("Continue this conversation");
  await expect(reply).toBeFocused();
  await screenshot(page, "space-lead-first-run");

  // A Try prompt fills the reply box.
  await page.getByRole("button", { name: "What's waiting on me?" }).click();
  await expect(reply).toContainText("What's waiting on me?");
});

test("a non-member reads the Lead", async ({ page, dashboard }) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${DOCS}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(
      "Which onboarding pages still describe the old setup flow?",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Continue this conversation")).toHaveCount(0);
  await expect(
    page.getByText("Join Docs refresh to message its Lead."),
  ).toBeVisible();
  await screenshot(page, "space-lead-non-member");
});

test("a non-member sees a Space whose Lead no member has talked to", async ({
  page,
  dashboard,
}) => {
  await page.route("**/api/spaces/*/lead", (route) =>
    route.fulfill({
      json: { error: "This Space has no Lead yet." },
      status: 404,
    }),
  );
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}${DOCS}`);
  await expect(
    page.getByText("No member has talked to this Space's Lead yet."),
  ).toBeVisible();
  // The Space's Threads are its Lead's, so it has none to list.
  await expect(
    page.getByRole("region", { exact: true, name: "Threads" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a phone shows the Lead, and its Space's details in a sheet", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    await page.goto(`${dashboard.baseURL}${BILLING}`);
    await expect(
      page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Billing migration" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Space details" }).click();
    const sheet = page.getByRole("dialog", { name: "Space details" });
    await sheet.getByRole("button", { name: "Done · 2" }).click();
    await expect(
      sheet.getByRole("link", { name: /Plan the billing migration/ }),
    ).toBeVisible();
    await expect(sheet.getByText("Avery Chen")).toBeVisible();
  });
});
