import type { Page } from "@playwright/test";

import { NOW_MS } from "../src/mock-reporting/fixtures";
import { expectRequestBudget } from "./request-budget";
import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const LEAD_REPLY =
  "Started both and watching them. I'll report back here when one needs you or finishes.";

/** Show a new Lead: its detail has no events yet. */
async function emptyLead(page: Page) {
  await page.route(
    /\/api\/conversations\/local%3Aweb%3A[0-9a-f]+(\?.*)?$/,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ json: { ...json, events: [] }, response });
    },
  );
}

test("home shows the Lead and the Conversations it started @classic", async ({
  page,
  dashboard,
}) => {
  // The fixture Conversations finished "today" at fixture time.
  await page.clock.setFixedTime(NOW_MS);
  await page.setViewportSize(desktop);
  await page.goto(dashboard.baseURL);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
  // Home is the Lead alone: no list and no details.
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /details/i })).toHaveCount(0);
  // The Lead nav item is home. The Conversations item is the list.
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(
    primary.getByRole("link", { name: "Lead", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    primary.getByRole("link", { name: "Conversations" }),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(
    transcript.getByRole("separator", { name: "Today" }),
  ).toBeVisible();

  // Each started Conversation is a card with its state, Brief, and Watch.
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

  // Watch Events show as one line each, before the Lead's reply.
  const reports = transcript.locator("[data-lead-watch-report]");
  await expect(reports).toHaveCount(2);
  await expect(reports.nth(0)).toContainText(
    "Triage Sentaur GoCD deployment failures needs you",
  );
  await expect(reports.nth(1)).toContainText(
    "Deployment investigation failed failed",
  );
  await expect(
    page.getByText("Ask your Lead to start, find, or check on work…"),
  ).toBeVisible();
  await screenshot(page, "lead-home-reports");
  await working.evaluate((element) => element.scrollIntoView());
  await screenshot(page, "lead-home");

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

  // "Message it" puts a reference to the card's Conversation in the reply.
  await failed.getByRole("button", { name: "Message it" }).click();
  await expect(reply).toContainText("Deployment investigation failed");

  // A card opens its Conversation, with the list beside it. New
  // conversation comes back to the Lead.
  await working
    .getByRole("link", { name: /Investigate checkout latency/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Investigate checkout latency" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Your conversations" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/`);
  await expect(reply).toBeFocused();
});

test("loads home within its request budget @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await expectRequestBudget(
    page,
    async () => {
      await page.goto(dashboard.baseURL, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { name: "Your Lead" }),
      ).toBeVisible();
    },
    { requests: 10, serialRounds: 3 },
  );
});

test("the Lead nav item opens the Lead from other pages", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/automations`);
  const lead = page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Lead", exact: true });
  await lead.click();
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
  await expect(
    page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
  ).toBeVisible();
  await expect(lead).toHaveAttribute("aria-current", "page");
  // A Lead has no details.
  await expect(page.getByRole("button", { name: /details/i })).toHaveCount(0);
});

test("a direct link to the Lead leaves the other rows their places @new", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(`${dashboard.baseURL}/automations`);
  const nav = page.getByRole("navigation", { name: "Primary" });
  const lead = nav.getByRole("link", { name: "Lead", exact: true });
  await lead.click();
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
  const leadPath = decodeURIComponent(new URL(page.url()).pathname);

  // Reload the Lead from a link with unencoded colons, with its id slow to
  // load. The Lead keeps its row, and Conversations still opens its list.
  await page.route("**/api/lead", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fallback();
  });
  await page.goto(`${dashboard.baseURL}${leadPath}`);
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
  await expect(lead).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page).toHaveURL(/\/\?view=conversations$/);
});

test("a new Lead introduces itself @classic", async ({ page, dashboard }) => {
  await emptyLead(page);
  await page.setViewportSize(desktop);
  await page.goto(dashboard.baseURL);
  await expect(
    page.getByRole("heading", { name: "This is your Lead" }),
  ).toBeVisible();
  for (const title of ["Starts work", "Keeps watch", "Finds and steers"]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  const reply = page.getByLabel("Continue this conversation");
  await expect(reply).toBeFocused();
  await screenshot(page, "lead-first-run");

  // A Try prompt fills the reply box.
  await page.getByRole("button", { name: "What's waiting on me?" }).click();
  await expect(reply).toContainText("What's waiting on me?");
});

test("the Conversations link opens the list beside the Lead @classic", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  await page.goto(dashboard.baseURL);
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
  await page.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page).toHaveURL(`${dashboard.baseURL}/conversations`);
  const list = page.getByRole("navigation", { name: "Your conversations" });
  await expect(list).toBeVisible();
  // The Lead is not in the list of Conversations.
  await expect(list).not.toContainText("Lead");
  await expect(page.getByRole("heading", { name: "Your Lead" })).toBeVisible();
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("narrow home is the Lead @classic", async ({ page, dashboard }) => {
    await page.clock.setFixedTime(NOW_MS);
    await page.setViewportSize(mobile);
    await page.goto(dashboard.baseURL);
    await expect(
      page.getByRole("heading", { name: "Your Lead" }),
    ).toBeVisible();
    const transcript = page.getByLabel("Conversation transcript");
    await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();

    await expect(
      transcript.getByRole("article", { name: "Investigate checkout latency" }),
    ).toBeVisible();

    // The list is its own page, with a link back to the Lead.
    await page.goto(`${dashboard.baseURL}/conversations`);
    await expect(
      page.getByRole("list", { name: "Your conversations" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Your Lead" }).click();
    await expect(transcript.getByText(LEAD_REPLY)).toBeVisible();
    // The app bar names the open Lead, and no list is beside it to toggle.
    await expect(page.getByRole("heading", { name: "Your Lead" })).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Show conversation list" }),
    ).toHaveCount(0);
  });

  test("the phone home lists the Lead first @new", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    const homeRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/lead",
    );
    await page.goto(dashboard.baseURL);
    const entries = page.getByRole("navigation", { name: "Primary" });
    await expect(entries.getByRole("link").first()).toHaveText("Lead");
    await homeRead;
    await entries.getByRole("link", { name: "Lead", exact: true }).click();
    await expect(
      page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
    ).toBeVisible();
  });

  test("the navigation sheet lists the Lead @classic", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    await page.goto(`${dashboard.baseURL}/automations`);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .getByRole("dialog", { name: "Navigation" })
      .getByRole("link", { name: "Lead", exact: true })
      .click();
    await expect(
      page.getByLabel("Conversation transcript").getByText(LEAD_REPLY),
    ).toBeVisible();
  });
});
