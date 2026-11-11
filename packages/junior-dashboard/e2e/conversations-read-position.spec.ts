import type { Locator, Page } from "@playwright/test";

import { withRequestedMailbox } from "./harness";
import { expect, test } from "./test";
import {
  mockReadPositionConversation,
  recordPageRequests,
} from "./read-position-fixture";
import { desktop, mobile, screenshot } from "./screenshot";

/** Open the Conversations bundle from the Inbox entries. */
async function openConversations(page: Page) {
  await page
    .getByRole("navigation", { name: "Inbox" })
    .getByRole("link", { exact: true, name: "Conversations" })
    .click();
}

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
 * Scroll up one viewport at a time until `row` mounts. Rows mount only near
 * the viewport, and a step of one viewport does not skip past them.
 */
async function scrollUpTo(transcript: Locator, row: Locator) {
  await expect(async () => {
    await transcript.evaluate((element) => {
      element.scrollTop -= element.clientHeight;
    });
    await expect(row).toBeAttached({ timeout: 250 });
  }).toPass({ intervals: [100] });
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
  // The page shell starts the first read before the client loads.
  let releaseClient!: () => void;
  const clientHeld = new Promise<void>((resolve) => {
    releaseClient = resolve;
  });
  await page.route("**/_junior/dashboard/assets/*.js", async (route) => {
    await clientHeld;
    await route.fallback();
  });

  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`, {
    waitUntil: "commit",
  });
  await expect
    .poll(() => mock.detailRequests)
    .toEqual(["?unreadPage=true&mailbox=true"]);
  releaseClient();
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  const latest = transcript.getByText("Transcript message 59 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();
  await expect(latest).not.toBeInViewport();
  // The client uses that response and does not read again.
  expect(mock.detailRequests).toEqual(["?unreadPage=true&mailbox=true"]);
  // Messages without finished Turns are quick to read, so no catch-up.
  await expect(
    transcript.getByRole("button", { name: "Catch me up" }),
  ).toHaveCount(0);
  await screenshot(page, "conversation-unread-marker", { view: "mobile" });

  // Opening is not reading. Input in the transcript is, so the first screen
  // then moves the shared position past the marker.
  expect(reported).toEqual([]);
  await transcript.hover();
  await page.mouse.wheel(0, 1);
  await expect.poll(() => reported.at(-1) ?? 0).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(latest).toBeInViewport();
  await expect.poll(() => reported.at(-1)).toBe(59);
  expect(reported).toEqual([...reported].sort((left, right) => left - right));

  // Readers who prefer the latest message open there, below the marker.
  await page.goto(`${dashboard.baseURL}/settings`);
  await page.getByRole("radio", { name: /Latest message/ }).click();
  const detailRequestCount = mock.detailRequests.length;
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  await expect(latest).toBeInViewport();
  await expect(marker).not.toBeInViewport();
  expect(mock.detailRequests.slice(detailRequestCount)).toEqual([
    "?mailbox=true",
  ]);
});

test("catches the reader up on several unread Turns", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(mobile);
  const mock = await mockReadPositionConversation(page, {
    eventCount: 60,
    lastReadSeq: 20,
  });
  mock.turnEndSeqs = [40, 50];
  const requested: unknown[] = [];
  await page.route(
    `**/api/conversations/${mock.conversationId}/catch-up`,
    async (route) => {
      requested.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          needsYou: "Review the Safari fix on PR #12.",
          summary: "CI failed on Safari after you left. Junior pushed a fix.",
        },
      });
    },
  );

  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const offer = transcript.getByRole("button", { name: "Catch me up" });
  // Seqs 21 to 59 are unread, and two of them finish Turns.
  await expect(offer).toHaveAccessibleName("Catch me up, 37 new messages");
  await offer.click();
  await expect(
    transcript.getByText("CI failed on Safari after you left."),
  ).toBeInViewport();
  await expect(
    transcript.getByText("Review the Safari fix on PR #12."),
  ).toBeVisible();
  // The range is the one from when the Conversation opened.
  expect(requested).toEqual([{ afterSeq: 20, throughSeq: 59 }]);
  await screenshot(page, "conversation-catch-up", { view: "mobile" });

  // The summary replaces the unread rows, so it leads straight to the latest.
  await transcript
    .getByRole("group", { name: "Catch-up" })
    .getByRole("button", { name: "Jump to latest" })
    .click();
  await expect(transcript.getByText("Transcript message 59 ")).toBeInViewport();
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
    // A phone returns to the Inbox entries. The Conversations bundle lists
    // the row.
    await page.getByRole("link", { name: /^Back to / }).click();
    await openConversations(page);
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
    const detailRequestCount = mock.detailRequests.length;
    await page
      .getByRole("link", { name: /Read position/ })
      .first()
      .click();
    await expect(transcript.getByText("Transcript message 39 ")).toBeVisible();
    await expect(marker).toHaveCount(0);
    releaseDetail();
    await newerRequest;
    // The fresh cached copy does not count as this visit's fetch, so the
    // reopen fetch still asks for the page around the read position.
    expect(mock.detailRequests[detailRequestCount]).toBe(
      "?unreadPage=true&mailbox=true",
    );
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
    await transcript.hover();
    await page.mouse.wheel(0, 1);
    await transcript
      .getByText("Transcript message 52 ")
      .scrollIntoViewIfNeeded();
    await page.getByRole("link", { name: /^Back to / }).click();
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

test.describe("opens from a hover prefetch", () => {
  // Fast-forward past the hover delay.
  test.use({ controlTimers: true });
  test("opens at new messages from a hover prefetch", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(desktop);
    const mock = await mockReadPositionConversation(page, {
      eventCount: 120,
      lastReadSeq: 20,
    });
    mock.pagedDetail = true;
    mock.servesUnreadPage = true;
    const pageRequests = recordPageRequests(page);
    await page.goto(`${dashboard.baseURL}/conversations`);
    const row = page.getByRole("link", { name: /Read position/ }).first();

    // A pointer that moves across the row fetches nothing.
    await row.hover();
    await page.mouse.move(0, 0);
    await page.clock.fastForward(1_000);
    expect(mock.detailRequests).toEqual([]);

    // A pointer that rests on the row fetches what the open would.
    await row.hover();
    await page.clock.fastForward(200);
    await expect
      .poll(() => mock.detailRequests)
      .toEqual(["?unreadPage=true&mailbox=true"]);

    // The open uses the prefetch as its first fetch. It opens at the marker
    // with no read of the page around the read position. It only checks for
    // newer events.
    await row.click();
    const transcript = page.getByLabel("Conversation transcript");
    const marker = transcript.getByRole("separator", { name: "New messages" });
    await expect(marker).toBeInViewport();
    await expect(
      transcript.getByText("Transcript message 21 "),
    ).toBeInViewport();
    // Seqs 21 to 119 are unread, and the page around the read position holds
    // 21 to 40. So the count is a lower bound, from the loaded rows only.
    await expect(
      transcript.getByRole("button", { name: "Catch me up" }),
    ).toHaveAccessibleName("Catch me up, 20+ new messages");
    await expect.poll(() => mock.detailRequests.length).toBe(2);
    expect(mock.detailRequests[1]).toBe("?mailbox=true");
    expect(pageRequests.filter((query) => query.includes("around"))).toEqual(
      [],
    );
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
  const pageRequests = recordPageRequests(page);
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(transcript.getByText("Transcript message 79 ")).toBeInViewport();
  // The earlier page loads above the reader and holds their place, so
  // scroll up to its first row.
  await scrollUpTo(transcript, transcript.getByText("Transcript message 0 "));

  // The earlier page stays cached. It is not the latest page, so the
  // transcript still needs the newer pages after the read position.
  await page.getByRole("link", { name: /^Back to / }).click();
  await openConversations(page);
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
  // Earlier pages fill the gap to the cached pages. Two loads that ask for
  // the same page share one request.
  await expect.poll(() => pageRequests).toContain("?before=160");
  expect(new Set(pageRequests).size).toBe(pageRequests.length);
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
  const pageRequests = recordPageRequests(page);
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
    kind: "root",
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
  let detailServed = () => {};
  const firstDetail = new Promise<void>((resolve) => {
    detailServed = resolve;
  });
  // The dashboard core reads end after the detail, so the page mounts after
  // the shell's detail fetch is done.
  await page.route("**/api/config", async (route) => {
    await firstDetail;
    await route.fallback();
  });
  await page.route(
    (url) => url.pathname === `/api/conversations/${conversationId}`,
    async (route) => {
      const { search } = new URL(route.request().url());
      detailRequests.push(search);
      const unreadPage = search.includes("unreadPage");
      await route.fulfill({
        json: withRequestedMailbox(route, {
          ...conversation,
          eventHistory: { status: "available" },
          events: events(latestSeq - 39, latestSeq),
          generatedAt,
          previousCursor: String(latestSeq - 39),
          readPosition: { lastReadSeq: 20 },
          unreadCursor: "20",
          ...(unreadPage ? { unreadPage: aroundPage(20) } : undefined),
        }),
      });
      detailServed();
    },
  );

  // On a direct load, the shell fetches the detail before the page mounts.
  // The page uses that fetch and does not fetch again.
  await page.goto(`${dashboard.baseURL}/conversations/${conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const marker = transcript.getByRole("separator", { name: "New messages" });
  const firstUnread = transcript.getByText("Transcript message 21 ");
  await expect(marker).toBeInViewport();
  await expect(firstUnread).toBeInViewport();
  // The first detail fetch brings the page around the read position: the
  // last read events and the unread events after them, and the mailbox.
  // Polls do not ask.
  expect(detailRequests[0]).toBe("?unreadPage=true&mailbox=true");

  // The latest page waits below until the newer pages reach it, so the
  // transcript has no gap. Newer pages load only when the reader scrolls to
  // them, so the server reads nothing the reader does not reach.
  await expect(transcript.getByText("Show newer messages")).toBeAttached();
  await expect(
    transcript.getByText(`Transcript message ${latestSeq} `),
  ).toHaveCount(0);
  expect(cursors).toEqual([]);

  // The read events before the marker come in the same page, so no earlier
  // page loads above the reader. Rows mount near the viewport, so scroll up
  // to them, but not near enough to the top to load an earlier page.
  await transcript.evaluate((element) => {
    element.scrollTop = 1_000;
  });
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
  await scrollUpTo(transcript, transcript.getByText("Transcript message 101 "));
  await scrollDownTo(
    transcript,
    transcript.getByText("Transcript message 141 "),
  );
  await expect(transcript.getByText("Loading newer messages…")).toHaveCount(0);
  expect(cursors).not.toContain("after-100");
  expect(detailRequests.length).toBeGreaterThan(1);
  expect(detailRequests.slice(1)).not.toContain(
    "?unreadPage=true&mailbox=true",
  );

  // A poll that skips more than one page cannot join the newer pages, so
  // the reader at the bottom goes to the latest page without a gap.
  latestSeq = 201;
  await expect(
    transcript.getByText("Transcript message 201 "),
  ).toBeInViewport();
  await expect(transcript.getByText("Show newer messages")).toHaveCount(0);
  const shown = await transcript.evaluate((element) => [
    ...new Set(
      [
        ...(element.textContent ?? "").matchAll(/Transcript message (\d+) /g),
      ].map((match) => Number(match[1])),
    ),
  ]);
  expect(shown.at(-1)! - shown[0]! + 1).toBe(shown.length);
});
