import { CONVERSATION_VERSION_HEADER } from "@sentry/junior/api/schema";
import { requestedConversationIds, withRequestedMailbox } from "./harness";
import { mockInboxItems, prReview, rowHead } from "./inbox/inbox-fixture";
import { expect, test } from "./test";
import { mockConversationDetail, mockObjectLinks } from "./mock-reports";

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
    conversationIds: [] as string[],
    conversations: "feed-1",
    inboxItems: "review-1",
    spend: "spend-1",
  };
  let versionReads = 0;
  let detailReads = 0;
  let feedReads = 0;
  let slackReply = false;
  await page.route("**/api/versions*", async (route) => {
    versionReads += 1;
    const { conversation, conversationIds: _, ...tokens } = versions;
    versions.conversationIds = requestedConversationIds(route);
    await route.fulfill({
      json: {
        ...tokens,
        conversationDetails: Object.fromEntries(
          versions.conversationIds.map((id) => [id, conversation]),
        ),
      },
    });
  });
  const feedStatuses: number[] = [];
  await page.route(
    (url) => url.pathname === "/api/conversations",
    async (route) => {
      if (route.request().method() === "GET") feedReads += 1;
      await route.fallback();
    },
  );
  const inboxItemStatuses: number[] = [];
  page.on("response", (response) => {
    if (response.request().method() !== "GET") return;
    const { pathname } = new URL(response.url());
    if (pathname === "/api/conversations") feedStatuses.push(response.status());
    if (pathname.startsWith("/api/inbox-items/")) {
      inboxItemStatuses.push(response.status());
    }
  });
  await page.route(
    (url) => url.pathname === detailPath,
    async (route) => {
      detailReads += 1;
      const report = withRequestedMailbox(
        route,
        await mockConversationDetail(route),
      );
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
      await route.fulfill({
        headers: { [CONVERSATION_VERSION_HEADER]: versions.conversation },
        json: report,
      });
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
  // The mock feed did not change, so the page comes back with no body and
  // the list keeps its rows.
  await expect.poll(() => feedStatuses.at(-1)).toBe(304);
  await expect(
    page.getByRole("link", { name: /Investigate checkout latency/ }).first(),
  ).toBeVisible();
  // The Inbox item reads did not change either.
  const inboxItemReads = inboxItemStatuses.length;
  versions.inboxItems = "review-2";
  await expect
    .poll(() => inboxItemStatuses.slice(inboxItemReads), { timeout: 15_000 })
    .toContain(304);
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
        json: {
          conversationDetails: {},
          conversations: "mock",
          inboxItems: "mock",
          spend: "mock",
        },
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

test.describe("refreshes each Conversation on screen from its token", () => {
  test.use({ controlTimers: true });
  test("an Inbox card shows its pull request merged when the token moves", async ({
    page,
    dashboard,
  }) => {
    // The release Conversation saved the card of this pull request.
    const releaseId = "slack:CQA456:1770021600.000600";
    const detailPath = `/api/conversations/${encodeURIComponent(releaseId)}`;
    const item = {
      ...prReview,
      owner: { id: releaseId, kind: "conversation" },
      id: "item-pr-versions",
      rootConversationId: releaseId,
    };
    let token = "1:1";
    let merged = false;
    let detailReads = 0;
    // The Conversation ids of each answered check.
    const checks: string[][] = [];
    const answered = async (count: number) => {
      await expect.poll(() => checks.length).toBeGreaterThanOrEqual(count);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    };
    // The Inbox items mock adds its own versions route. A later route runs
    // first, so this one comes after it to see each check.
    await mockInboxItems(page, { open: [item] });
    await page.route("**/api/versions*", async (route) => {
      const ids = requestedConversationIds(route);
      await route.fulfill({
        json: {
          conversationDetails: Object.fromEntries(
            ids.filter((id) => id === releaseId).map((id) => [id, token]),
          ),
          conversations: "mock",
          inboxItems: "mock",
          spend: "mock",
        },
      });
      checks.push(ids);
    });
    await page.route(
      (url) => url.pathname === detailPath,
      async (route) => {
        detailReads += 1;
        const report = withRequestedMailbox(
          route,
          await mockConversationDetail(route),
        );
        if (merged) {
          for (const annotation of report.annotations) {
            if (annotation.key === "getsentry/payments#91") {
              annotation.status = "merged";
            }
          }
        }
        await route.fulfill({
          headers: { [CONVERSATION_VERSION_HEADER]: token },
          json: report,
        });
      },
    );
    // The card reads the pull request live.
    await page.route(/\/api\/objects\?/, async (route) => {
      const report = await mockObjectLinks(route);
      await route.fulfill({
        json: {
          objects: report.objects.map((entry) =>
            merged &&
            entry.object &&
            entry.url.endsWith("/getsentry/payments/pull/91")
              ? { ...entry, object: { ...entry.object, status: "merged" } }
              : entry,
          ),
        },
      });
    });
    await page.goto(`${dashboard.baseURL}/inbox?type=prs`);
    await rowHead(page, "Pin the release train").click();
    const card = page.getByRole("region", {
      name: "Pull request: Pin the release train to payments 4.2",
    });
    await expect(card.getByText("open", { exact: true })).toBeVisible();

    // The check asks for the card's Conversation, though it is not open.
    const tick = async () => {
      const count = checks.length;
      await page.clock.fastForward(5_000);
      await answered(count + 1);
    };
    await tick();
    expect(checks.at(-1)).toContain(releaseId);

    // An unchanged token reads nothing, with no timed poll of the detail.
    const settled = detailReads;
    for (let step = 0; step < 6; step += 1) await tick();
    expect(detailReads).toBe(settled);

    // The moved token refreshes the Conversation and the live card.
    merged = true;
    token = "1:2";
    await page.clock.fastForward(5_000);
    await expect(card.getByText("merged", { exact: true })).toBeVisible();
    expect(detailReads).toBe(settled + 1);
  });

  test("a card whose Conversation read failed reads it again", async ({
    page,
    dashboard,
  }) => {
    const releaseId = "slack:CQA456:1770021600.000600";
    const detailPath = `/api/conversations/${encodeURIComponent(releaseId)}`;
    const item = {
      ...prReview,
      owner: { id: releaseId, kind: "conversation" },
      id: "item-pr-versions-retry",
      rootConversationId: releaseId,
    };
    let failing = true;
    let detailReads = 0;
    let checks = 0;
    // Let each answered check finish, and the reads it starts begin.
    const tick = async () => {
      const count = checks;
      await page.clock.fastForward(5_000);
      await expect.poll(() => checks).toBeGreaterThan(count);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    };
    // The Inbox items mock adds its own versions route. A later route runs
    // first, so this one comes after it to see each check.
    await mockInboxItems(page, { open: [item] });
    await page.route("**/api/versions*", async (route) => {
      await route.fulfill({
        json: {
          conversationDetails: {},
          conversations: "mock",
          inboxItems: "mock",
          spend: "mock",
        },
      });
      checks += 1;
    });
    await page.route(
      (url) => url.pathname === detailPath,
      async (route) => {
        detailReads += 1;
        // A transient server error.
        if (failing) {
          await route.fulfill({ json: { error: "busy" }, status: 503 });
          return;
        }
        await route.fallback();
      },
    );
    await page.goto(`${dashboard.baseURL}/inbox?type=prs`);
    await rowHead(page, "Pin the release train").click();
    await expect.poll(() => detailReads).toBeGreaterThan(0);
    // The reads that mounting the row starts are done after one check.
    await tick();

    // Once the server answers again, the next check reads the detail.
    failing = false;
    const settled = detailReads;
    await tick();
    await expect.poll(() => detailReads).toBeGreaterThan(settled);
  });
});
