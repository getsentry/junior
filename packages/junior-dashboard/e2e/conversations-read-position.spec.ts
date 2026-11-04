import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const PAGE_SIZE = 40;

/** Scroll to the end of the transcript until `row` renders. */
async function scrollDownTo(transcript: Locator, row: Locator) {
  await expect(async () => {
    await transcript.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(row).toBeAttached({ timeout: 500 });
  }).toPass();
}

/**
 * Mock one completed Conversation whose server read position moves forward.
 * Its detail never brings `unreadPage`, so the page around the read position
 * comes from the events API, like when the first fetch did not ask for it.
 */
async function mockReadPositionConversation(
  page: Page,
  input: { eventCount: number; lastReadSeq: number },
) {
  const generatedAt = "2026-08-07T11:00:00.000Z";
  const conversationId = "read-position";
  const conversation = {
    conversationId,
    cumulativeDurationMs: 1_000,
    displayTitle: "Read position",
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status: "completed",
    surface: "internal",
  };
  const state = {
    conversationId,
    eventCount: input.eventCount,
    /** Holds detail responses until it resolves. */
    detailGate: Promise.resolve(),
    /** Holds `around` and `after` page responses until it resolves. */
    newerGate: Promise.resolve(),
    /** The first `around` or `after` cursor that `newerGate` holds. */
    newerGateAfter: 0,
    /** Fail the pages that `newerGate` holds. */
    failNewer: false,
    /** The event that starts Turn `turn-<seq>`. */
    turnStartSeq: -1,
    /** Return only the latest page in detail, like the server. */
    pagedDetail: false,
    reported: [] as number[],
  };
  let stored = input.lastReadSeq;

  await page.route("**/api/conversations", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        conversations: [conversation],
        generatedAt,
        source: "conversation_index",
      },
    });
  });
  await page.route(
    `**/api/conversations/${conversationId}/pending-messages`,
    async (route) => {
      await route.fulfill({
        json: { conversationId, generatedAt, messages: [] },
      });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/messages`,
    async (route) => {
      await route.fulfill({
        json: { conversationId, messageId: "sent", status: "accepted" },
      });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/read-position`,
    async (route) => {
      const { lastReadSeq } = route.request().postDataJSON() as {
        lastReadSeq: number;
      };
      state.reported.push(lastReadSeq);
      stored = Math.max(stored, lastReadSeq);
      await route.fulfill({ json: { lastReadSeq: stored } });
    },
  );
  const events = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const seq = from + index;
      return {
        createdAt: new Date(
          Date.parse(generatedAt) + seq * 1_000,
        ).toISOString(),
        data:
          seq === state.turnStartSeq
            ? {
                type: "turn_lifecycle",
                state: "started",
                turnId: `turn-${seq}`,
              }
            : {
                type: "message",
                messageId: `message-${seq}`,
                role: seq % 2 === 0 ? "user" : "assistant",
                text: `Transcript message ${seq} with enough content to occupy a visible row.`,
              },
        seq,
      };
    });
  await page.route(
    `**/api/conversations/${conversationId}/events?*`,
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const after = query.get("after");
      const around = query.get("around");
      const newer = after ?? around;
      if (newer && Number(newer) >= state.newerGateAfter) {
        await state.newerGate;
        if (state.failNewer) {
          await route.fulfill({ status: 500, json: { error: "failed" } });
          return;
        }
      }
      const latestSeq = state.eventCount - 1;
      // Like the server, an `around` page ends half of its events with the
      // cursor event.
      const [from, to] = after
        ? [Number(after) + 1, Math.min(Number(after) + PAGE_SIZE, latestSeq)]
        : around
          ? [
              Math.max(0, Number(around) - PAGE_SIZE / 2 + 1),
              Math.min(Number(around) + PAGE_SIZE / 2, latestSeq),
            ]
          : [
              Math.max(0, Number(query.get("before")) - PAGE_SIZE),
              Number(query.get("before")) - 1,
            ];
      await route.fulfill({
        json: {
          eventHistory: { status: "available" },
          events: events(from, to),
          generatedAt,
          ...(from > 0 ? { previousCursor: String(from) } : undefined),
          ...(to < latestSeq ? { nextCursor: String(to) } : undefined),
        },
      });
    },
  );
  await page.route(`**/api/conversations/${conversationId}*`, async (route) => {
    await state.detailGate;
    const firstSeq = state.pagedDetail
      ? Math.max(0, state.eventCount - PAGE_SIZE)
      : 0;
    await route.fulfill({
      json: {
        ...conversation,
        eventHistory: { status: "available" },
        events: events(firstSeq, state.eventCount - 1),
        generatedAt,
        readPosition: { lastReadSeq: stored },
        ...(firstSeq > 0 ? { previousCursor: String(firstSeq) } : undefined),
        ...(stored + 1 < firstSeq
          ? { unreadCursor: String(stored) }
          : undefined),
      },
    });
  });
  return state;
}

test("opens where the reader left off and reports what they read", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 60,
    lastReadSeq: 20,
  });
  const { reported } = mock;

  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  const latest = transcript.getByText("Transcript message 59 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();
  await expect(latest).not.toBeInViewport();
  await screenshot(page, "conversation-unread-marker", { view: "mobile" });

  // Reading the first screen moves the shared position past the marker.
  await expect.poll(() => reported.at(-1) ?? 0).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(latest).toBeInViewport();
  await expect.poll(() => reported.at(-1)).toBe(59);
  expect(reported).toEqual([...reported].sort((left, right) => left - right));

  // Readers who prefer the latest message open there, below the marker.
  await page.goto(`${dashboard.baseURL}/settings`);
  await page.getByRole("radio", { name: /Latest message/ }).click();
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  await expect(latest).toBeInViewport();
  await expect(marker).not.toBeInViewport();
});

test.describe("opens at new messages after a cached reopen", () => {
  // Fast-forward past the read report delay while the cached copy waits.
  test.use({ controlTimers: true });
  test("opens at new messages after a cached reopen and keeps a quick exit", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    const mock = await mockReadPositionConversation(page, {
      eventCount: 40,
      lastReadSeq: 39,
    });
    await page.goto(
      `${dashboard.baseURL}/conversations/${mock.conversationId}`,
    );
    const transcript = page.getByLabel("Conversation transcript");
    const marker = transcript.getByRole("separator", { name: "New messages" });
    await expect(
      transcript.getByText("Transcript message 39 "),
    ).toBeInViewport();
    await expect(marker).toHaveCount(0);

    // More than a page arrives while the reader is away. The reopen shows the
    // cached copy first. The fetch then brings the read position's cursor,
    // although the cached copy has none. The cached copy stays until the page
    // after the read position loads, and the transcript opens there.
    await page.getByRole("link", { name: "Back to conversations" }).click();
    mock.eventCount = 120;
    mock.pagedDetail = true;
    let releaseDetail = () => {};
    mock.detailGate = new Promise((resolve) => {
      releaseDetail = resolve;
    });
    let releaseNewer = () => {};
    mock.newerGate = new Promise((resolve) => {
      releaseNewer = resolve;
    });
    const newerRequest = page.waitForRequest((request) =>
      request.url().includes("/events?around="),
    );
    await page
      .getByRole("link", { name: /Read position/ })
      .first()
      .click();
    await expect(transcript.getByText("Transcript message 39 ")).toBeVisible();
    await expect(marker).toHaveCount(0);
    releaseDetail();
    await newerRequest;
    await expect(transcript.getByText("Transcript message 39 ")).toBeVisible();
    await expect(transcript.getByText("Transcript message 119 ")).toHaveCount(
      0,
    );
    releaseNewer();
    await expect(marker).toBeInViewport();
    await expect(
      transcript.getByText("Transcript message 40 "),
    ).toBeInViewport();
    await expect(
      transcript.getByText("Transcript message 119 "),
    ).not.toBeInViewport();

    // Leaving right after a scroll still saves the place.
    const reportCount = mock.reported.length;
    await transcript
      .getByText("Transcript message 52 ")
      .scrollIntoViewIfNeeded();
    await page.getByRole("link", { name: "Back to conversations" }).click();
    await expect
      .poll(() => mock.reported.slice(reportCount).at(-1) ?? 0)
      .toBeGreaterThanOrEqual(52);

    // The composer pins the latest event. On a reopen, that can come while the
    // cached copy waits for the fetch. The transcript then opens at the latest
    // page, not at the read position.
    mock.eventCount = 200;
    mock.detailGate = new Promise((resolve) => {
      releaseDetail = resolve;
    });
    await page
      .getByRole("link", { name: /Read position/ })
      .first()
      .click();
    await expect(
      transcript.getByText("Transcript message 119 "),
    ).toBeInViewport();
    // The held copy sits at its latest rows, which the reader has not read.
    const reportsBeforeHold = mock.reported.length;
    await page.clock.fastForward(1_000);
    expect(mock.reported.slice(reportsBeforeHold)).toEqual([]);
    await page.getByLabel("Continue this conversation").focus();
    releaseDetail();
    await expect(
      transcript.getByText("Transcript message 199 "),
    ).toBeInViewport();
    await expect(marker).not.toBeInViewport();
    await expect(
      transcript.getByRole("button", { name: "Load newer events" }),
    ).toHaveCount(0);
  });
});

test("opens at new messages after earlier pages were cached", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 80,
    lastReadSeq: 79,
  });
  mock.pagedDetail = true;
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("Transcript message 79 ")).toBeInViewport();
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(transcript.getByText("Transcript message 0 ")).toBeAttached();

  // The earlier page stays cached. It is not the latest page, so the
  // transcript still needs the newer pages after the read position.
  await page.getByRole("link", { name: "Back to conversations" }).click();
  mock.eventCount = 200;
  mock.newerGateAfter = 80;
  let releaseNewer = () => {};
  mock.newerGate = new Promise((resolve) => {
    releaseNewer = resolve;
  });
  await page
    .getByRole("link", { name: /Read position/ })
    .first()
    .click();
  const marker = transcript.getByRole("separator", { name: "New messages" });
  await expect(marker).toBeInViewport();
  await expect(
    transcript.getByRole("button", { name: "Load newer events" }),
  ).toBeAttached();
  await expect(transcript.getByText("Transcript message 199 ")).toHaveCount(0);

  // A send waits in the queue. The transcript does not end at the latest
  // event yet, so the send has no place there. The send shows the latest
  // page at once, without the newer pages. On mobile, the composer focus
  // already shows it, so this part runs on desktop.
  await page.setViewportSize(desktop);
  await page.getByLabel("Continue this conversation").fill("Sent while behind");
  await page.getByRole("button", { name: "Send" }).click();
  const pending = page.getByLabel("Pending messages");
  await expect(pending.getByText("Sent while behind")).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 199 "),
  ).toBeInViewport();
  await expect(
    transcript.getByRole("button", { name: "Load newer events" }),
  ).toHaveCount(0);
  releaseNewer();
});

test("jumps to the latest page without the newer pages", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 200,
    lastReadSeq: 20,
  });
  mock.pagedDetail = true;
  // Newer pages after the page around the read position never load.
  mock.newerGateAfter = 21;
  let releaseNewer = () => {};
  mock.newerGate = new Promise((resolve) => {
    releaseNewer = resolve;
  });
  const pageRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) pageRequests.push(url.search);
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByRole("separator", { name: "New messages" }),
  ).toBeInViewport();

  // The reader at the end of the loaded pages can still jump. The latest
  // page is in the detail, so the jump shows it at once.
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(transcript.getByText("Loading newer messages…")).toBeAttached();
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await jump.click();
  await expect(
    transcript.getByText("Transcript message 199 "),
  ).toBeInViewport();
  await expect(jump).toHaveCount(0);
  await expect(
    transcript.getByRole("button", { name: "Load newer events" }),
  ).toHaveCount(0);
  expect(pageRequests).toEqual(["?around=20", "?after=40"]);

  // Earlier pages load above the latest page as the reader scrolls up.
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(transcript.getByText("Transcript message 159 ")).toBeAttached();
  expect(pageRequests.slice(2)).toEqual(["?before=160"]);
  releaseNewer();
});

test("opens linked events and Turns that newer pages have not loaded yet", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 10,
  });
  mock.pagedDetail = true;
  // The page around the read position loads. The next one waits.
  mock.newerGateAfter = 11;
  let releaseNewer = () => {};
  mock.newerGate = new Promise((resolve) => {
    releaseNewer = resolve;
  });
  const heldRequest = page.waitForRequest((request) =>
    request.url().includes("/events?after=30"),
  );
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?event=70`,
  );
  const linked = page.getByRole("complementary", {
    name: "Event details",
    exact: true,
  });
  await heldRequest;
  await expect(linked).toBeVisible();
  releaseNewer();
  await expect(linked).toContainText("Transcript message 70 ");

  // A failed newer page keeps a Turn link, so a retry can still open it.
  mock.turnStartSeq = 70;
  mock.failNewer = true;
  await page.goto(
    `${dashboard.baseURL}/conversations/${mock.conversationId}?turn=turn-70`,
  );
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText("Newer events could not be loaded."),
  ).toBeVisible();
  await expect(transcript.getByText("Transcript message 0 ")).toBeAttached();
  await expect(page).toHaveURL(/[?&]turn=turn-70(&|$)/);
  mock.failNewer = false;
  await transcript.getByRole("button", { name: "Load newer events" }).click();
  await expect(page).toHaveURL(/[?&]event=70(&|$)/);
  await expect(linked).toBeVisible();
});

test("opens far behind at the read position and loads newer pages after it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const generatedAt = "2026-08-07T11:00:00.000Z";
  const conversationId = "far-behind";
  const conversation = {
    conversationId,
    cumulativeDurationMs: 1_000,
    displayTitle: "Far behind",
    isParticipant: true,
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    // Active Conversations poll every 2s, so new events reach the page.
    status: "active",
    surface: "internal",
  };
  let latestSeq = 139;
  const events = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const seq = from + index;
      return {
        createdAt: new Date(
          Date.parse(generatedAt) + seq * 1_000,
        ).toISOString(),
        data: {
          type: "message",
          messageId: `message-${seq}`,
          role: seq % 2 === 0 ? "user" : "assistant",
          text: `Transcript message ${seq} with enough content to occupy a visible row.`,
        },
        seq,
      };
    });
  const aroundPage = (seq: number) => ({
    eventHistory: { status: "available" },
    events: events(seq - 19, seq + 20),
    generatedAt,
    previousCursor: String(seq - 19),
    nextCursor: String(seq + 20),
  });
  const cursors: string[] = [];
  let releaseNewerPage = () => {};
  const newerPageGate = new Promise<void>((resolve) => {
    releaseNewerPage = resolve;
  });

  await page.route("**/api/conversations", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        conversations: [conversation],
        generatedAt,
        source: "conversation_index",
      },
    });
  });
  await page.route(
    `**/api/conversations/${conversationId}/pending-messages`,
    async (route) => {
      await route.fulfill({
        json: { conversationId, generatedAt, messages: [] },
      });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/events?*`,
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const after = query.get("after");
      const around = query.get("around");
      const before = query.get("before");
      cursors.push(
        after
          ? `after-${after}`
          : around
            ? `around-${around}`
            : `before-${before}`,
      );
      if (around) {
        await route.fulfill({ json: aroundPage(Number(around)) });
        return;
      }
      if (after) {
        const from = Number(after) + 1;
        const to = Math.min(from + 39, latestSeq);
        if (from > 21) await newerPageGate;
        await route.fulfill({
          json: {
            eventHistory: { status: "available" },
            events: events(from, to),
            generatedAt,
            previousCursor: String(from),
            ...(to < latestSeq ? { nextCursor: String(to) } : undefined),
          },
        });
        return;
      }
      const to = Number(before) - 1;
      const from = Math.max(0, to - 39);
      await route.fulfill({
        json: {
          eventHistory: { status: "available" },
          events: events(from, to),
          generatedAt,
          ...(from > 0 ? { previousCursor: String(from) } : undefined),
        },
      });
    },
  );
  const detailRequests: string[] = [];
  await page.route(
    (url) => url.pathname === `/api/conversations/${conversationId}`,
    async (route) => {
      const { search } = new URL(route.request().url());
      detailRequests.push(search);
      const unreadPage = search.includes("unreadPage");
      await route.fulfill({
        json: {
          ...conversation,
          eventHistory: { status: "available" },
          events: events(latestSeq - 39, latestSeq),
          generatedAt,
          previousCursor: String(latestSeq - 39),
          readPosition: { lastReadSeq: 20 },
          unreadCursor: "20",
          ...(unreadPage ? { unreadPage: aroundPage(20) } : undefined),
        },
      });
    },
  );

  // A direct load also mounts the app shell, which reads the same detail.
  await page.goto(`${dashboard.baseURL}/conversations/${conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();
  // The first detail fetch brings the page around the read position: the
  // last read events and the unread events after them. Polls do not ask.
  expect(detailRequests[0]).toBe("?unreadPage=true");

  // The latest page waits below until the newer pages reach it, so the
  // transcript has no gap. Newer pages load only when the reader scrolls to
  // them, so the server reads nothing the reader does not reach.
  await expect(transcript.getByText("Show newer messages")).toBeAttached();
  await expect(
    transcript.getByText(`Transcript message ${latestSeq} `),
  ).toHaveCount(0);
  expect(cursors).toEqual([]);

  // The read events before the marker come in the same page, so no earlier
  // page loads above the reader.
  await expect(
    transcript.getByText("Transcript message 1 with", { exact: false }),
  ).toBeAttached();
  await expect(transcript.getByText("Transcript message 0 ")).toHaveCount(0);

  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(transcript.getByText("Loading newer messages…")).toBeAttached();
  releaseNewerPage();
  // The page loads below the reader and does not pull them down, so the
  // next page waits until they scroll to it.
  await expect(transcript.getByText("Transcript message 41 ")).toBeInViewport();
  await expect(transcript.getByText("Show newer messages")).toBeAttached();
  expect(cursors).toEqual(["after-40"]);
  await scrollDownTo(
    transcript,
    transcript.getByText(`Transcript message ${latestSeq} `),
  );
  await expect(transcript.getByText("Show newer messages")).toHaveCount(0);
  await expect(marker).toHaveCount(1);
  // The pages from the latest page back are never read.
  expect(cursors).not.toContain("before-100");

  // New events push the joined events out of the latest page. They stay, so
  // the latest events do not leave, and no newer page loads again.
  latestSeq = 141;
  await expect(transcript.getByText("Transcript message 141 ")).toBeAttached();
  await expect(transcript.getByText("Transcript message 101 ")).toBeAttached();
  await expect(transcript.getByText("Loading newer messages…")).toHaveCount(0);
  expect(cursors).not.toContain("after-100");
  expect(detailRequests.length).toBeGreaterThan(1);
  expect(detailRequests.slice(1)).not.toContain("?unreadPage=true");
});
