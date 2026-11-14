import {
  CONVERSATION_DETAIL_VERSION_HEADER,
  CONVERSATION_VERSION_HEADER,
} from "@sentry/junior/api/schema";
import { withRequestedMailbox } from "./harness";
import { expect, test } from "./test";

const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";

test("refreshes idle reads only when their version moves", async ({
  page,
  dashboard,
}) => {
  // Real poll intervals.
  test.setTimeout(60_000);
  const detailPath = `/api/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`;
  const versions = {
    conversation: "1:1",
    conversations: "feed-1",
    reviewItems: "review-1",
    spend: "spend-1",
  };
  let versionReads = 0;
  let detailReads = 0;
  let feedReads = 0;
  let slackReply = false;
  await page.route("**/api/versions*", async (route) => {
    versionReads += 1;
    await route.fulfill({ json: versions });
  });
  await page.route(
    (url) => url.pathname === "/api/conversations",
    async (route) => {
      if (route.request().method() === "GET") feedReads += 1;
      await route.fallback();
    },
  );
  await page.route(
    (url) => url.pathname === detailPath,
    async (route) => {
      detailReads += 1;
      // Request the full body because this test changes it.
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          [CONVERSATION_DETAIL_VERSION_HEADER]: "",
        },
      });
      const report = withRequestedMailbox(route, await response.json());
      if (slackReply) {
        report.events.push({
          seq: 100_000,
          createdAt: report.lastSeenAt,
          data: {
            type: "message",
            messageId: "slack-reply",
            role: "user",
            text: "A reply from Slack",
          },
        });
      }
      const headers = response.headers();
      delete headers["content-length"];
      headers[CONVERSATION_VERSION_HEADER] = versions.conversation;
      await route.fulfill({ headers, json: report });
    },
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
  );
  await expect.poll(() => versionReads).toBeGreaterThanOrEqual(2);
  const settled = { detailReads, feedReads, versionReads };

  // Unchanged tokens refresh nothing.
  await expect
    .poll(() => versionReads, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(settled.versionReads + 2);
  expect({ detailReads, feedReads }).toEqual({
    detailReads: settled.detailReads,
    feedReads: settled.feedReads,
  });

  // Each moved token refreshes its own read.
  slackReply = true;
  versions.conversation = "1:2";
  await expect(
    page.getByText("A reply from Slack", { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  expect(feedReads).toBe(settled.feedReads);
  versions.conversations = "feed-2";
  await expect
    .poll(() => feedReads, { timeout: 15_000 })
    .toBeGreaterThan(settled.feedReads);
});

test.describe("checks less often while the reader is away", () => {
  test.use({ controlTimers: true });
  test("checks less often while the reader is away", async ({
    page,
    dashboard,
  }) => {
    // Page clock time of each answered check.
    const checks: number[] = [];
    // A timer that fires while a check is in flight joins that check. Let
    // the page finish each answer before the clock moves.
    const answered = async (count: number) => {
      await expect.poll(() => checks.length).toBe(count);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    };
    await page.route("**/api/versions*", async (route) => {
      const at = await page.evaluate(() => Date.now());
      await route.fulfill({
        json: { conversations: "mock", reviewItems: "mock", spend: "mock" },
      });
      checks.push(at);
    });
    await page.goto(
      `${dashboard.baseURL}/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    );
    await answered(1);
    await page.clock.fastForward(5_000);
    await answered(2);

    // Five minutes without input: the due check runs, then every 10s.
    await page.clock.fastForward("05:00");
    await answered(3);
    await page.clock.fastForward(5_000);
    await page.clock.fastForward(5_000);
    await answered(4);
    expect(checks[3] - checks[2]).toBeGreaterThanOrEqual(10_000);

    // Input checks at once and goes back to every 5s.
    await page.mouse.move(10, 10);
    await answered(5);
    await page.clock.fastForward(5_000);
    await answered(6);
  });
});
