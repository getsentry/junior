import type { Page } from "@playwright/test";

import { expect, test } from "./test";
import { mobile, screenshot } from "./screenshot";

const PAGE_SIZE = 40;

/** Mock one completed Conversation whose server read position moves forward. */
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
    /** Holds `after` page responses until it resolves. */
    newerGate: Promise.resolve(),
    /** The first `after` cursor that `newerGate` holds. */
    newerGateAfter: 0,
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
        data: {
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
      if (after && Number(after) >= state.newerGateAfter) {
        await state.newerGate;
      }
      const latestSeq = state.eventCount - 1;
      const from = after
        ? Number(after) + 1
        : Math.max(0, Number(query.get("before")) - PAGE_SIZE);
      const to = after
        ? Math.min(from + PAGE_SIZE - 1, latestSeq)
        : Number(query.get("before")) - 1;
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
  await page.route(`**/api/conversations/${conversationId}`, async (route) => {
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

test("opens at new messages after a cached reopen and keeps a quick exit", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 40,
    lastReadSeq: 39,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  await expect(transcript.getByText("Transcript message 39 ")).toBeInViewport();
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
    request.url().includes("/events?after="),
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
  await expect(transcript.getByText("Transcript message 119 ")).toHaveCount(0);
  releaseNewer();
  await expect(marker).toBeInViewport();
  await expect(transcript.getByText("Transcript message 40 ")).toBeInViewport();
  await expect(
    transcript.getByText("Transcript message 119 "),
  ).not.toBeInViewport();

  // Leaving right after a scroll still saves the place.
  const reportCount = mock.reported.length;
  await transcript.getByText("Transcript message 52 ").scrollIntoViewIfNeeded();
  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect
    .poll(() => mock.reported.slice(reportCount).at(-1) ?? 0)
    .toBeGreaterThanOrEqual(52);
});

test("opens a linked event that newer pages have not loaded yet", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const mock = await mockReadPositionConversation(page, {
    eventCount: 120,
    lastReadSeq: 10,
  });
  mock.pagedDetail = true;
  // The first page after the read position loads. The next one waits.
  mock.newerGateAfter = 11;
  let releaseNewer = () => {};
  mock.newerGate = new Promise((resolve) => {
    releaseNewer = resolve;
  });
  const heldRequest = page.waitForRequest((request) =>
    request.url().includes("/events?after=50"),
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
      const before = query.get("before");
      cursors.push(after ? `after-${after}` : `before-${before}`);
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
  await page.route(`**/api/conversations/${conversationId}`, async (route) => {
    await route.fulfill({
      json: {
        ...conversation,
        eventHistory: { status: "available" },
        events: events(latestSeq - 39, latestSeq),
        generatedAt,
        previousCursor: String(latestSeq - 39),
        readPosition: { lastReadSeq: 20 },
        unreadCursor: "20",
      },
    });
  });

  await page.goto(`${dashboard.baseURL}/conversations/${conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();

  // The latest page waits below until the newer pages reach it, so the
  // transcript has no gap.
  await expect(transcript.getByText("Loading newer messages…")).toBeAttached();
  await expect(
    transcript.getByText(`Transcript message ${latestSeq} `),
  ).toHaveCount(0);

  // Earlier context loads above the reader without moving them.
  await expect(transcript.getByText("Transcript message 0 ")).toBeAttached();
  await expect(firstUnread).toBeInViewport();

  releaseNewerPage();
  await expect(
    transcript.getByText(`Transcript message ${latestSeq} `),
  ).toBeAttached();
  await expect(transcript.getByText("Loading newer messages…")).toHaveCount(0);
  await expect(firstUnread).toBeInViewport();
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
});
