import type { Locator, Page } from "@playwright/test";

import { withRequestedMailbox } from "./harness";

/** A mock Conversation and helpers for the long transcript specs. */

export const EVENT_COUNT = 2_000;
export const PAGE_SIZE = 40;
// The transcript mounts the rows near the viewport, not the loaded rows.
export const MAX_MOUNTED_ROWS = 60;
// An event in the middle of the transcript captured two memories.
export const MEMORY_CAPTURE_SEQ = 1_000;

/**
 * Mock one completed Conversation with 2,000 message events. With `paged`,
 * the detail holds only the latest page, like the server, and earlier pages
 * wait for `holdEarlier` before they load. Every page read takes
 * `readDelayMs` to load, like a server read, and waits for `holdReads`.
 * Pages honor `limit` like the server. Every other event is a person
 * message, or every `personEvery`th.
 */
export async function mockLongConversation(
  page: Page,
  input: { lastReadSeq: number; paged: boolean; personEvery?: number },
) {
  const personEvery = input.personEvery ?? 2;
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
    status: "done",
    turnActive: false,
    surface: "internal",
  };
  const state = {
    conversationId,
    /** Holds `before` pages until it resolves. */
    holdEarlier: Promise.resolve(),
    /** Holds every page read until it resolves. */
    holdReads: Promise.resolve(),
    pageRequests: [] as string[],
    readDelayMs: 0,
    /** The seq range that each page read served, in order. */
    pageRanges: [] as [number, number][],
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
                role: seq % personEvery === 0 ? "user" : "assistant",
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
  // Like the server, a page around an event holds half of `limit` up to and
  // with the event, and the rest after it.
  const aroundRange = (around: number, limit: number): [number, number] => [
    Math.max(0, around - Math.floor(limit / 2) + 1),
    Math.min(around + limit - Math.floor(limit / 2), lastSeq),
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
      await route.fulfill({
        json: route.request().postDataJSON(),
      });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/events?*`,
    async (route) => {
      const { search, searchParams } = new URL(route.request().url());
      state.pageRequests.push(search);
      const after = searchParams.get("after");
      const message = /^message-(\d+)$/.exec(
        searchParams.get("message") ?? "",
      )?.[1];
      const around =
        searchParams.get("around") ?? searchParams.get("event") ?? message;
      const before = searchParams.get("before");
      if (before) await state.holdEarlier;
      await state.holdReads;
      if (state.readDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
      }
      const limit = Number(searchParams.get("limit") ?? PAGE_SIZE);
      const [from, to] = after
        ? [Number(after) + 1, Math.min(Number(after) + limit, lastSeq)]
        : around
          ? aroundRange(Number(around), limit)
          : [Math.max(0, Number(before) - limit), Number(before) - 1];
      state.pageRanges.push([from, to]);
      await route.fulfill({ json: eventPage(from, to) });
    },
  );
  await page.route(
    `**/api/conversations/${conversationId}/outline`,
    async (route) => {
      await route.fulfill({
        json: {
          items: events(0, lastSeq).flatMap(({ createdAt, data, seq }) =>
            data.type === "message" && data.role === "user"
              ? [
                  {
                    actorIdentityId: "identity-asker",
                    createdAt,
                    seq,
                    text: data.text,
                    reply: `Transcript message ${seq + 1} with enough content to occupy a visible row.`,
                  },
                ]
              : [],
          ),
        },
      });
    },
  );
  await page.route("**/api/memory/conversations/*/memories", async (route) => {
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
  });
  await page.route(`**/api/conversations/${conversationId}*`, async (route) => {
    const firstSeq = input.paged ? EVENT_COUNT - PAGE_SIZE : 0;
    const behind = input.lastReadSeq + 1 < firstSeq;
    await route.fulfill({
      json: withRequestedMailbox(route, {
        ...conversation,
        authors: { "identity-asker": { fullName: "Andrew Asker" } },
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

/** Count the transcript rows that are mounted. */
export function mountedRows(transcript: Locator) {
  return transcript.locator("[data-transcript-seq]").count();
}

/** The transcript row of an event seq. */
export function row(transcript: Locator, seq: number) {
  return transcript.locator(`[data-transcript-seq="${seq}"]`);
}

/**
 * True when the transcript hides its scrollbar. Headless Chrome hides every
 * scrollbar, so read the style that hides it.
 */
export function scrollbarHidden(transcript: Locator): Promise<boolean> {
  return transcript.evaluate(
    (element) => getComputedStyle(element).scrollbarWidth === "none",
  );
}

/**
 * The distance from the viewport to the bottom of the transcript. Rows that
 * load above the reader leave the content below them unchanged, so a held
 * place keeps the same distance to the bottom.
 */
export function distanceFromBottom(transcript: Locator): Promise<number> {
  return transcript.evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

/**
 * Record each row seq that gets the jump mark, which is brief. Returns a
 * reader of the seqs.
 */
export async function recordRowMarks(page: Page) {
  await page.addInitScript(() => {
    const marks: number[] = [];
    Object.assign(window, { rowMarks: marks });
    new MutationObserver((changes) => {
      for (const { target } of changes) {
        const row = target as Element;
        if (row.hasAttribute("data-highlighted")) {
          marks.push(Number(row.getAttribute("data-transcript-seq")));
        }
      }
    }).observe(document, {
      attributeFilter: ["data-highlighted"],
      subtree: true,
    });
  });
  return () =>
    page.evaluate(
      () => (window as Window & { rowMarks?: number[] }).rowMarks ?? [],
    );
}
