import { CONVERSATION_DETAIL_VERSION_HEADER } from "@sentry/junior/api/schema";
import { createHash } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webMessageId } from "@sentry/junior/api/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import { JUNIOR_VERSION } from "@sentry/junior/version";
import * as z from "zod";

import { createDashboardApp } from "../src/app";
import { auth, embeddedBootstrap } from "./dashboard-test-helpers";
import {
  ARCHIVED_CONVERSATION_ID,
  resetMockConversationViewerState,
  setMockConversationArchived,
} from "../src/mock-reporting/fixtures";
import {
  DASHBOARD_VERSION_DRIFT_MESSAGE,
  dashboardVersionDrift,
} from "../src/client/dashboard-version";
import { DASHBOARD_VERSION_HEADER } from "../src/dashboard-version";
import {
  conversationDetailQueryOptions,
  readConversationData,
  readConversationEvents,
} from "../src/client/conversations/queries";
import { conversationSideReadQueryKey } from "../src/client/conversations/conversationSideReads";
import {
  INBOX_ITEMS_QUERY_KEY,
  inboxItemListQueryKey,
  useConversationInboxItemData,
} from "../src/client/inbox/queries";
import { dashboardCoreQueryOptions } from "../src/client/api";
import { fetchDashboardJson } from "../src/client/http";

const generatedAt = "2026-07-23T00:00:00.000Z";

function event(seq: number): ConversationReportEvent {
  return {
    createdAt: generatedAt,
    data: {
      type: "message_handled",
      messageId: `message-${seq}`,
    },
    seq,
  };
}

describe("dashboard client API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves stored web Message ids when deriving them in the browser", async () => {
    const conversationId = "slack:C1:123";
    const idempotencyKey = "attempt-1";
    const storedId = `api-msg:${createHash("sha256")
      .update(`${conversationId}\u0000${idempotencyKey}`)
      .digest("hex")
      .slice(0, 24)}`;
    expect(await webMessageId({ conversationId, idempotencyKey })).toBe(
      storedId,
    );
  });

  it("seeds core data from the page shell once, then reads the API", async () => {
    const app = createDashboardApp({
      agentName: "Junior",
      allowedDomains: ["example.com"],
      mockConversations: true,
      auth: auth({ user: { email: "dev@example.com", emailVerified: true } }),
    });
    const html = await (
      await app.fetch(new Request("http://localhost/"))
    ).text();
    const bootstrap = embeddedBootstrap(html);
    expect(bootstrap).toBeDefined();
    const reads: string[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      reads.push(path);
      return app.fetch(new Request(`http://localhost${path}`, init));
    });
    const shellWindow: Record<string, unknown> = {
      __JUNIOR_DASHBOARD_BOOTSTRAP__: bootstrap,
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal("window", shellWindow);

    await expect(
      new QueryClient().fetchQuery(dashboardCoreQueryOptions()),
    ).resolves.toEqual(bootstrap);
    expect(reads).toEqual([]);
    expect(shellWindow).not.toHaveProperty("__JUNIOR_DASHBOARD_BOOTSTRAP__");

    await expect(
      new QueryClient().fetchQuery(dashboardCoreQueryOptions()),
    ).resolves.toEqual(bootstrap);
    expect(reads.sort()).toEqual(["/api/config", "/api/me"]);
  });

  it("restarts Google sign-in when product API auth expires", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "unauthenticated" }, { status: 401 }),
      ),
    );
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "?filter=recent",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 401",
    );
    expect(assign).toHaveBeenCalledWith(
      "/auth/login?next=%2Fconversations%3Ffilter%3Drecent",
    );
  });

  it("requests older events before the supplied cursor", async () => {
    const response = {
      events: [event(1)],
      eventHistory: { status: "available" as const },
      generatedAt,
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      readConversationEvents("slack:C1:123", "history cursor"),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123/events?before=history+cursor",
      { credentials: "same-origin" },
    );
  });

  it("appends a poll's newer events to the cached detail", async () => {
    const conversationId = "slack:C1:123";
    const detail = {
      conversationId,
      kind: "root" as const,
      cumulativeDurationMs: 1,
      displayTitle: "Active conversation",
      eventHistory: { status: "available" as const },
      events: [event(4), event(5)],
      generatedAt,
      isParticipant: true,
      lastProgressAt: generatedAt,
      lastSeenAt: generatedAt,
      mailbox: { conversationId, generatedAt, messages: [] },
      startedAt: generatedAt,
      status: "working" as const,
      surface: "slack" as const,
      turnActive: true,
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...detail,
        appendCursor: "after-6",
        appended: true,
        events: [event(6)],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const next = await readConversationData(
      conversationId,
      undefined,
      { ...detail, appendCursor: "after-5", previousCursor: "before-4" },
      { mailbox: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/slack%3AC1%3A123?mailbox=true&after=after-5",
      expect.anything(),
    );
    expect(next.events.map((item) => item.seq)).toEqual([4, 5, 6]);
    expect(next).toMatchObject({
      appendCursor: "after-6",
      previousCursor: "before-4",
    });
    expect(next).not.toHaveProperty("appended");
  });

  it("rejects a history page whose cursor does not advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          events: [],
          eventHistory: { status: "available" },
          generatedAt,
          previousCursor: "same-cursor",
        }),
      ),
    );

    await expect(
      readConversationEvents("slack:C1:123", "same-cursor"),
    ).rejects.toThrow("Conversation history cursor did not advance");
  });

  it("reads a transcript Inbox item from its Conversation's list", () => {
    const conversationId = "slack:C1:123";
    const client = new QueryClient();
    client.setQueryData(inboxItemListQueryKey({ conversationId }), {
      pageParams: [undefined],
      pages: [{ items: [{ id: "listed", title: "Listed item" }] }],
    });
    const detail = (id: string) =>
      client.getQueryCache().find({
        exact: true,
        queryKey: [...INBOX_ITEMS_QUERY_KEY, "detail", id],
      });
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(function Row() {
            const { data } = useConversationInboxItemData(conversationId, id);
            return data?.title ?? "loading";
          }),
        ),
      );

    expect(render("listed")).toBe("Listed item");
    expect(detail("listed")).toBeUndefined();
    // An item that the list leaves out, such as a closed one, loads by itself.
    expect(render("closed")).toBe("loading");
    expect(detail("closed")).toBeDefined();
  });

  it("revalidates detail without caching the mailbox or bypassing sign-in", async () => {
    let signedIn = true;
    const sessionAuth = auth({
      user: { email: "dev@example.com", emailVerified: true },
    });
    const app = createDashboardApp({
      agentName: "Junior",
      allowedDomains: ["example.com"],
      mockConversations: true,
      auth: {
        ...sessionAuth,
        getSession: (request) =>
          signedIn ? sessionAuth.getSession(request) : Promise.resolve(null),
      },
    });
    const reads: Array<[path: string, status: number]> = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      const request = new Request(`http://localhost${path}`, init);
      const response = await app.fetch(request);
      reads.push([path, response.status]);
      return response;
    });
    const client = new QueryClient();
    const options = conversationDetailQueryOptions(ARCHIVED_CONVERSATION_ID);
    const detailPath = `/api/conversations/${encodeURIComponent(ARCHIVED_CONVERSATION_ID)}`;
    // The details panel reads these beside the detail report, and the
    // transcript reads its open items from the list. An Inbox list that
    // shows an item of this Conversation shows its subject from this
    // detail, so it refreshes with it. The versions poll refreshes the other
    // Inbox item reads.
    const inbox = inboxItemListQueryKey({ forViewer: true, sort: "waiting" });
    const otherInbox = inboxItemListQueryKey({ forViewer: true });
    const sideReads = [
      conversationSideReadQueryKey(ARCHIVED_CONVERSATION_ID, "agents"),
      inboxItemListQueryKey({ conversationId: ARCHIVED_CONVERSATION_ID }),
      inbox,
      [...INBOX_ITEMS_QUERY_KEY, "detail", "item-1"],
      inboxItemListQueryKey({ conversationId: "slack:C1:other" }),
      otherInbox,
      [...INBOX_ITEMS_QUERY_KEY, "count"],
      [...INBOX_ITEMS_QUERY_KEY, "waiting-conversations"],
    ];
    const listOf = (ownerId: string) => ({
      pageParams: [undefined],
      // The API names the root of an owner that the viewer can see.
      pages: [
        {
          items: [
            {
              owner: { id: ownerId, kind: "conversation" },
              rootConversationId: ownerId,
            },
          ],
        },
      ],
    });
    const sideReadsInvalidated = () =>
      sideReads.map((key) => client.getQueryState(key)?.isInvalidated);
    try {
      const first = await client.fetchQuery(options);
      for (const key of sideReads) client.setQueryData(key, {});
      client.setQueryData(inbox, listOf(ARCHIVED_CONVERSATION_ID));
      client.setQueryData(otherInbox, listOf("slack:C1:other"));
      const second = await client.fetchQuery(options);
      expect(second.events).toBe(first.events);
      expect(sideReadsInvalidated()).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      // Each read brings the mailbox with the detail. An unchanged poll gets
      // only the mailbox and keeps the cached detail.
      expect(reads).toEqual([
        [`${detailPath}?mailbox=true`, 200],
        [`${detailPath}?mailbox=true`, 200],
      ]);
      expect(first.mailbox?.conversationId).toBe(ARCHIVED_CONVERSATION_ID);
      expect(second.mailbox).not.toBe(first.mailbox);

      setMockConversationArchived(ARCHIVED_CONVERSATION_ID, false);
      const changed = await client.fetchQuery(options);
      expect(first.archivedAt).toBeTruthy();
      expect(changed.archivedAt).toBeUndefined();
      expect(changed.detailEtag).not.toBe(first.detailEtag);
      expect(reads.at(-1)).toEqual([`${detailPath}?mailbox=true`, 200]);
      expect(sideReadsInvalidated()).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
      ]);

      // The detail endpoint must also reject a valid old validator after logout.
      signedIn = false;
      const denied = await app.fetch(
        new Request(`http://localhost${detailPath}`, {
          headers: {
            [CONVERSATION_DETAIL_VERSION_HEADER]: changed.detailEtag!,
          },
        }),
      );
      expect(denied.status).toBe(401);
    } finally {
      client.clear();
      resetMockConversationViewerState();
    }
  });

  it("keeps polling a running Turn after a failed refresh, even when it needs input", () => {
    const options = conversationDetailQueryOptions("slack:C1:123");
    const interval = options.refetchInterval;
    if (typeof interval !== "function") {
      throw new Error("Expected a dynamic polling interval");
    }
    // A partial TanStack Query object holds only the fields the interval reads.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const query = {
      state: {
        data: {
          conversationId: "slack:C1:123",
          cumulativeDurationMs: 1,
          displayTitle: "Active conversation",
          eventHistory: { status: "available" },
          events: [],
          generatedAt,
          isParticipant: true,
          lastProgressAt: generatedAt,
          lastSeenAt: generatedAt,
          startedAt: generatedAt,
          // An open action item outranks the running Turn in `status`.
          status: "needs_input",
          surface: "slack",
          turnActive: true,
        },
        error: new Error("temporary failure"),
      },
    } as unknown as Parameters<typeof interval>[0];

    expect(interval(query)).toBe(2_000);
  });

  it("detects a newer server version without false positives", () => {
    expect(dashboardVersionDrift("999.0.0")).toBe(true);
    expect(dashboardVersionDrift(JUNIOR_VERSION)).toBe(false);
    expect(dashboardVersionDrift("unknown")).toBe(false);
    expect(dashboardVersionDrift()).toBe(false);
  });

  it("publishes the server version from dashboard responses", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { events: [], eventHistory: { status: "available" }, generatedAt },
          { headers: { [DASHBOARD_VERSION_HEADER]: "999.0.0" } },
        ),
      ),
    );

    await readConversationEvents("slack:C1:123", "history cursor");

    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      detail: "999.0.0",
      type: "junior:dashboard-version",
    });
  });

  it("names version drift when a newer server sends unknown fields", async () => {
    const schema = z.object({ label: z.string() }).strict();
    const respond = (version: string) =>
      Response.json(
        { label: "PR", title: "New field" },
        { headers: { [DASHBOARD_VERSION_HEADER]: version } },
      );
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond("999.0.0")),
    );

    await expect(fetchDashboardJson(schema, "/api/x")).rejects.toThrow(
      DASHBOARD_VERSION_DRIFT_MESSAGE,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(JUNIOR_VERSION)),
    );

    await expect(fetchDashboardJson(schema, "/api/x")).rejects.toThrow(
      "Unrecognized key",
    );
  });

  it("does not redirect for non-auth product API failures", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    vi.stubGlobal("window", {
      location: {
        assign,
        pathname: "/conversations",
        search: "",
      },
    });

    await expect(readConversationData("slack:C1:123")).rejects.toThrow(
      "/api/conversations/slack%3AC1%3A123 returned 403",
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
