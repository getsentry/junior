import type { Page } from "@playwright/test";

import { withRequestedMailbox } from "./harness";

const PAGE_SIZE = 40;

/** Record the query of each events page request. */
export function recordPageRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) requests.push(url.search);
  });
  return requests;
}

/**
 * Mock one completed Conversation whose server read position moves forward.
 * Its detail brings `unreadPage` only when `servesUnreadPage` is set. Else the
 * page around the read position comes from the events API, like when the
 * first fetch did not ask for it.
 */
export async function mockReadPositionConversation(
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
    /** Holds `around`, `after`, and link page responses until it resolves. */
    newerGate: Promise.resolve(),
    /** The first `around` or `after` cursor or link seq that it holds. */
    newerGateAfter: 0,
    /** Fail the pages that `newerGate` holds. */
    failNewer: false,
    /** The event that starts Turn `turn-<seq>`. */
    turnStartSeq: -1,
    /** The event that captured the memories of the shared memory mock. */
    memoryCaptureSeq: -1,
    /** Events that finish a Turn. */
    turnEndSeqs: [] as number[],
    /** Return only the latest page in detail, like the server. */
    pagedDetail: false,
    /** Return the page around the read position when a detail asks for it. */
    servesUnreadPage: false,
    /** The query of each detail request. */
    detailRequests: [] as string[],
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
            : seq === state.memoryCaptureSeq
              ? {
                  type: "structured_event",
                  namespace: "memory",
                  name: "memories_captured",
                  version: 1,
                  turnId: "qa-turn",
                  presentation: { icon: "brain", title: "2 memories captured" },
                }
              : state.turnEndSeqs.includes(seq)
                ? {
                    type: "turn_lifecycle",
                    state: "succeeded",
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
      const turn = query.get("turn");
      if (turn && turn !== `turn-${state.turnStartSeq}`) {
        await route.fulfill({
          status: 404,
          json: { error: "Turn not found." },
        });
        return;
      }
      // Like the server, a link asks for the page around its event.
      const around =
        query.get("around") ??
        query.get("event") ??
        (turn ? String(state.turnStartSeq) : null);
      const newer = after ?? around;
      if (newer && Number(newer) >= state.newerGateAfter) {
        await state.newerGate;
        if (state.failNewer) {
          await route.fulfill({ status: 500, json: { error: "failed" } });
          return;
        }
      }
      const latestSeq = state.eventCount - 1;
      const [from, to] = after
        ? [Number(after) + 1, Math.min(Number(after) + PAGE_SIZE, latestSeq)]
        : around
          ? aroundRange(Number(around))
          : [
              Math.max(0, Number(query.get("before")) - PAGE_SIZE),
              Number(query.get("before")) - 1,
            ];
      await route.fulfill({ json: eventPage(from, to) });
    },
  );
  // Like the server, an `around` page ends half of its events with the
  // cursor event.
  const aroundRange = (around: number): [number, number] => [
    Math.max(0, around - PAGE_SIZE / 2 + 1),
    Math.min(around + PAGE_SIZE / 2, state.eventCount - 1),
  ];
  const eventPage = (from: number, to: number) => ({
    eventHistory: { status: "available" },
    events: events(from, to),
    generatedAt,
    ...(from > 0 ? { previousCursor: String(from) } : undefined),
    ...(to < state.eventCount - 1 ? { nextCursor: String(to) } : undefined),
  });
  await page.route(`**/api/conversations/${conversationId}*`, async (route) => {
    const { search, searchParams } = new URL(route.request().url());
    state.detailRequests.push(search);
    await state.detailGate;
    const firstSeq = state.pagedDetail
      ? Math.max(0, state.eventCount - PAGE_SIZE)
      : 0;
    const behind = stored + 1 < firstSeq;
    await route.fulfill({
      json: withRequestedMailbox(route, {
        ...conversation,
        eventHistory: { status: "available" },
        events: events(firstSeq, state.eventCount - 1),
        generatedAt,
        readPosition: { lastReadSeq: stored },
        ...(firstSeq > 0 ? { previousCursor: String(firstSeq) } : undefined),
        ...(behind ? { unreadCursor: String(stored) } : undefined),
        ...(behind &&
        state.servesUnreadPage &&
        searchParams.get("unreadPage") === "true"
          ? { unreadPage: eventPage(...aroundRange(stored)) }
          : undefined),
      }),
    });
  });
  return state;
}
