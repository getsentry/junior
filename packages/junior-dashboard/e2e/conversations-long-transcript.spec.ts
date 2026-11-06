import type { Locator, Page } from "@playwright/test";

import { withRequestedMailbox } from "./harness";
import { expect, test } from "./test";
import { desktop, mobile, screenshot } from "./screenshot";

const EVENT_COUNT = 2_000;
const PAGE_SIZE = 40;
// The transcript mounts the rows near the viewport, not the loaded rows.
const MAX_MOUNTED_ROWS = 60;
// An event in the middle of the transcript captured two memories.
const MEMORY_CAPTURE_SEQ = 1_000;

/**
 * Mock one completed Conversation with 2,000 message events. With `paged`,
 * the detail holds only the latest page, like the server, and earlier pages
 * wait for `holdEarlier` before they load.
 */
async function mockLongConversation(
  page: Page,
  input: { lastReadSeq: number; paged: boolean },
) {
  const generatedAt = "2026-08-07T11:00:00.000Z";
  const conversationId = "long-transcript";
  const conversation = {
    conversationId,
    cumulativeDurationMs: 1_000,
    displayTitle: "Long transcript",
    isParticipant: true,
    kind: "root",
    lastProgressAt: generatedAt,
    lastSeenAt: generatedAt,
    startedAt: generatedAt,
    status: "completed",
    surface: "internal",
  };
  const state = {
    conversationId,
    /** Holds `before` pages until it resolves. */
    holdEarlier: Promise.resolve(),
    pageRequests: [] as string[],
  };
  const lastSeq = EVENT_COUNT - 1;
  const events = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const seq = from + index;
      return {
        createdAt: new Date(
          Date.parse(generatedAt) + seq * 1_000,
        ).toISOString(),
        data:
          seq === MEMORY_CAPTURE_SEQ
            ? {
                type: "structured_event",
                namespace: "memory",
                name: "memories_captured",
                version: 1,
                turnId: "qa-turn",
                presentation: { icon: "brain", title: "2 memories captured" },
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
  const eventPage = (from: number, to: number) => ({
    eventHistory: { status: "available" },
    events: events(from, to),
    generatedAt,
    ...(from > 0 ? { previousCursor: String(from) } : undefined),
    ...(to < lastSeq ? { nextCursor: String(to) } : undefined),
  });
  const aroundRange = (around: number): [number, number] => [
    Math.max(0, around - PAGE_SIZE / 2 + 1),
    Math.min(around + PAGE_SIZE / 2, lastSeq),
  ];

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
      await route.fulfill({ json: route.request().postDataJSON() });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/events?*`,
    async (route) => {
      const { search, searchParams } = new URL(route.request().url());
      state.pageRequests.push(search);
      const after = searchParams.get("after");
      const around = searchParams.get("around") ?? searchParams.get("event");
      const before = searchParams.get("before");
      if (before) await state.holdEarlier;
      const [from, to] = after
        ? [Number(after) + 1, Math.min(Number(after) + PAGE_SIZE, lastSeq)]
        : around
          ? aroundRange(Number(around))
          : [Math.max(0, Number(before) - PAGE_SIZE), Number(before) - 1];
      await route.fulfill({ json: eventPage(from, to) });
    },
  );
  await page.route(
    "**/api/plugins/memory/conversations/*/memories",
    async (route) => {
      await route.fulfill({
        json: {
          events: [
            {
              memoryIds: ["recalled-memory"],
              seq: 2,
              source: "recalled",
              turnId: "first-turn",
            },
            {
              memoryIds: ["captured-memory-1", "captured-memory-2"],
              seq: MEMORY_CAPTURE_SEQ,
              source: "captured",
              turnId: "qa-turn",
            },
          ],
          memories: [
            {
              content: "Checkout investigations start with deployments.",
              id: "recalled-memory",
              visibility: "public",
            },
            {
              content: "Use pnpm for repository commands.",
              id: "captured-memory-1",
              visibility: "private",
            },
            {
              content: "Dashboard transcript events should remain expandable.",
              id: "captured-memory-2",
              visibility: "public",
            },
          ],
        },
      });
    },
  );
  await page.route(`**/api/conversations/${conversationId}*`, async (route) => {
    const firstSeq = input.paged ? EVENT_COUNT - PAGE_SIZE : 0;
    const behind = input.lastReadSeq + 1 < firstSeq;
    await route.fulfill({
      json: withRequestedMailbox(route, {
        ...conversation,
        eventHistory: { status: "available" },
        events: events(firstSeq, lastSeq),
        generatedAt,
        readPosition: { lastReadSeq: input.lastReadSeq },
        ...(firstSeq > 0 ? { previousCursor: String(firstSeq) } : undefined),
        ...(behind ? { unreadCursor: String(input.lastReadSeq) } : undefined),
      }),
    });
  });
  return state;
}

function mountedRows(transcript: Locator) {
  return transcript.locator("[data-transcript-seq]").count();
}

function row(transcript: Locator, seq: number) {
  return transcript.locator(`[data-transcript-seq="${seq}"]`);
}

// Rows that load above the reader leave the content below them unchanged, so
// a held place keeps the same distance to the bottom.
function distanceFromBottom(transcript: Locator): Promise<number> {
  return transcript.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

test("mounts only the rows near the viewport of a long transcript", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: false,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  await expect(row(transcript, MEMORY_CAPTURE_SEQ)).toHaveCount(0);

  // A memory jump mounts its far row before it scrolls there.
  const details = page.getByRole("complementary", {
    name: "Conversation details",
    exact: true,
  });
  await details
    .getByRole("button", { name: "1 recalled · 2 captured" })
    .click();
  await details
    .getByRole("listitem")
    .filter({ hasText: "Dashboard transcript events should remain" })
    .getByRole("button", { name: "Go to message" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Captured 2 memories" }),
  ).toBeVisible();
  await expect(row(transcript, MEMORY_CAPTURE_SEQ)).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  await screenshot(page, "conversation-long-transcript-memory", {
    view: "desktop",
  });
  await page.keyboard.press("Escape");

  // Search finds rows that are not mounted.
  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByPlaceholder("Search transcript…");
  await expect(search).toBeFocused();
  await search.fill("Transcript message 123");
  await expect(page.getByText("1/11", { exact: true })).toBeVisible();
  // Enter goes to the next match. Shift+Enter goes back and wraps around.
  await search.press("Enter");
  await expect(page.getByText("2/11", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1230 "),
  ).toBeInViewport();
  await search.press("Shift+Enter");
  await search.press("Shift+Enter");
  await expect(page.getByText("11/11", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1239 "),
  ).toBeInViewport();

  // A second press goes to the browser's find.
  await page.evaluate(() => {
    window.addEventListener(
      "keydown",
      (event) => {
        document.body.dataset.findPrevented = String(event.defaultPrevented);
      },
      { once: true },
    );
  });
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator("body")).toHaveAttribute(
    "data-find-prevented",
    "false",
  );

  // Escape closes the search, not the details panel.
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(details).toBeVisible();
});

test("keeps a Reply rating while its row unmounts", async ({
  page,
  dashboard,
}) => {
  const feedback: unknown[] = [];
  await page.addInitScript(() => {
    Object.assign(window, {
      __JUNIOR_DASHBOARD_SENTRY__: {
        dsn: "https://public@sentry.example/1",
        tracesSampleRate: 0,
      },
    });
  });
  await page.route("https://sentry.example/**", async (route) => {
    const item = route.request().postData()?.split("\n").at(-1) ?? "";
    if (item.includes('"type":"feedback"')) feedback.push(JSON.parse(item));
    await route.fulfill({ json: {} });
  });
  await page.clock.install();
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: false,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const reply = row(transcript, EVENT_COUNT - 1);
  const good = reply.getByRole("button", { name: "Good reply" });
  const bad = reply.getByRole("button", { name: "Bad reply" });
  const scrollTo = (place: "top" | "bottom") =>
    transcript.evaluate(
      (element, top) => element.scrollTo({ top }),
      place === "top" ? 0 : 1e9,
    );
  await good.hover();
  await good.click();

  // A pending Good stays pending while its row unmounts, then sends once.
  await scrollTo("top");
  await expect(reply).toHaveCount(0);
  await scrollTo("bottom");
  await expect(good).toHaveAttribute("aria-pressed", "true");
  await expect(bad).toBeVisible();
  await scrollTo("top");
  await expect(reply).toHaveCount(0);
  await page.clock.runFor(5000);
  await expect.poll(() => feedback.length).toBe(1);
  await scrollTo("bottom");
  await expect(good).toHaveAttribute("aria-pressed", "true");
  await expect(bad).toHaveCount(0);
  await good.click();
  await page.clock.runFor(5000);
  expect(feedback).toHaveLength(1);
});

test("jumps to a far message from the outline", async ({ page, dashboard }) => {
  // The outline shows only beside a transcript with room to its left.
  await page.setViewportSize({ height: 900, width: 1920 });
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: false,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  const outline = page.getByRole("navigation", {
    name: "Conversation outline",
  });
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  await expect(row(transcript, 1_234)).toHaveCount(0);

  const item = outline.getByRole("button", {
    name: "Transcript message 1234 with",
  });
  await item.click();
  // The message starts at the top of the viewport.
  await expect(row(transcript, 1_234)).toBeInViewport({ ratio: 1 });
  await expect(row(transcript, 1_233)).not.toBeInViewport({ ratio: 0.5 });
  await expect(item).toHaveAttribute("aria-current", "location");
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
});

test("holds the top row while earlier pages load above it", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();

  for (let load = 1; load <= 4; load += 1) {
    let release = () => {};
    mock.holdEarlier = new Promise((resolve) => {
      release = resolve;
    });
    const firstSeq = EVENT_COUNT - PAGE_SIZE * load;
    await transcript.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      transcript.getByText("Loading earlier messages…"),
    ).toBeVisible();
    const firstRow = row(transcript, firstSeq);
    await expect(firstRow).toBeInViewport();
    const distance = await distanceFromBottom(transcript);
    release();
    // The last row of the earlier page mounts just above the reader.
    await expect(row(transcript, firstSeq - 1)).toBeAttached();
    await expect
      .poll(async () =>
        Math.abs((await distanceFromBottom(transcript)) - distance),
      )
      .toBeLessThan(2);
    await expect(firstRow).toBeInViewport();
    expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  }
  expect(mock.pageRequests).toEqual(
    [1, 2, 3, 4].map((load) => `?before=${EVENT_COUNT - PAGE_SIZE * load}`),
  );
});

test("keeps the current search match while earlier pages load", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: EVENT_COUNT - 1,
    paged: true,
  });
  let release = () => {};
  mock.holdEarlier = new Promise((resolve) => {
    release = resolve;
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();

  await page.keyboard.press("ControlOrMeta+f");
  const search = page.getByPlaceholder("Search transcript…");
  // The latest page holds 1969, 1979, 1989, and 1999.
  await search.fill("9 with");
  await expect(page.getByText("1/4", { exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByText("2/4", { exact: true })).toBeVisible();

  // The earlier page adds four matches before 1979, which stays current.
  mock.holdEarlier = new Promise(() => {});
  release();
  await expect(page.getByText("6/8", { exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(page.getByText("7/8", { exact: true })).toBeVisible();
  await expect(
    transcript.getByText("Transcript message 1989 "),
  ).toBeInViewport();
});

test("opens far behind at the marker and jumps to the latest", async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize(desktop);
  const mock = await mockLongConversation(page, {
    lastReadSeq: 1_000,
    paged: true,
  });
  await page.goto(`${dashboard.baseURL}/conversations/${mock.conversationId}`);
  const transcript = page.getByLabel("Conversation transcript");
  await expect(
    transcript.getByRole("separator", { name: "New messages" }),
  ).toBeInViewport();
  await expect(
    transcript.getByText("Transcript message 1001 "),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);

  await page.getByRole("button", { name: "Jump to latest" }).first().click();
  await expect(
    transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
  ).toBeInViewport();
  expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("scrolls up through a long transcript without corrections", async ({
    page,
    dashboard,
  }) => {
    await page.setViewportSize(mobile);
    const mock = await mockLongConversation(page, {
      lastReadSeq: EVENT_COUNT - 1,
      paged: false,
    });
    await page.goto(
      `${dashboard.baseURL}/conversations/${mock.conversationId}`,
    );
    const transcript = page.getByLabel("Conversation transcript");
    await expect(
      transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
    ).toBeInViewport();

    // Count the scroll corrections of the scroll owner. Rows that mount
    // above the reader use the measured size of rows like them, so a touch
    // scroll needs none.
    await transcript.evaluate((element) => {
      const scrollTo = element.scrollTo.bind(element);
      element.dataset.scrollCorrections = "0";
      element.scrollTo = (...args: Parameters<typeof scrollTo>) => {
        element.dataset.scrollCorrections = String(
          Number(element.dataset.scrollCorrections) + 1,
        );
        scrollTo(...args);
      };
    });
    const session = await page.context().newCDPSession(page);
    // The transcript fills the width of a phone.
    const x = Math.round(mobile.width / 2);
    for (let swipe = 0; swipe < 6; swipe += 1) {
      // CDP touch events scroll like a finger. Playwright has no swipe.
      const points = (y: number) => [{ x, y }];
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: points(200),
        type: "touchStart",
      });
      for (let y = 220; y <= 700; y += 20) {
        await session.send("Input.dispatchTouchEvent", {
          touchPoints: points(y),
          type: "touchMove",
        });
      }
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: [],
        type: "touchEnd",
      });
    }
    await expect(
      transcript.getByText(`Transcript message ${EVENT_COUNT - 1} `),
    ).toHaveCount(0);
    await expect(transcript).toHaveAttribute("data-scroll-corrections", "0");
    expect(await mountedRows(transcript)).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
    await screenshot(page, "conversation-long-transcript-touch", {
      view: "mobile",
    });
  });
});
