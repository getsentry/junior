import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type Versions, versionsSchema } from "@sentry/junior/api/schema";

import {
  type ConversationSnapshot,
  conversationDetailIsLive,
  conversationDetailQueryKey,
} from "./conversations/queries";
import { fetchDashboardJson } from "./http";
import { REVIEW_ITEMS_QUERY_KEY } from "./review-desk/queries";

const VERSIONS_QUERY_KEY = ["dashboard", "versions"] as const;

/**
 * The reads below refresh only when their token moves, so this interval is
 * the longest wait, for a reader who is present, before an idle
 * Conversation, the feed, the spend meter, or the Review count shows a
 * change.
 */
const VERSIONS_POLL_MS = 5_000;

/**
 * A reader with no input for this long is away: the tab can be visible on
 * another screen, but nobody acts on it. Hidden tabs do not poll at all.
 */
const AWAY_AFTER_MS = 5 * 60_000;

/**
 * Poll interval while the reader is away, the same as the old idle detail
 * poll. Input checks at once.
 */
const AWAY_POLL_MS = 10_000;

const READER_INPUT_EVENTS = [
  "focus",
  "keydown",
  "pointerdown",
  "pointermove",
  "touchstart",
  "wheel",
] as const;

function readerIsAway(lastInputAtMs: number) {
  return Date.now() - lastInputAtMs >= AWAY_AFTER_MS;
}

/**
 * Refresh the reads whose token moved since the last poll. Only mounted
 * queries refetch. The first poll of a tab sets the baseline: a change that
 * lands between a read and that poll waits for the next change or focus.
 */
function refreshChangedReads(
  client: QueryClient,
  previous: Versions | undefined,
  next: Versions,
  conversationId: string | undefined,
) {
  const moved = (field: "conversations" | "reviewItems" | "spend") =>
    previous !== undefined && previous[field] !== next[field];
  // Waiting Conversations outside the newest page join the feed.
  if (moved("conversations") || moved("reviewItems")) {
    void client.invalidateQueries({ queryKey: ["dashboard", "conversations"] });
  }
  if (moved("reviewItems")) {
    void client.invalidateQueries({ queryKey: REVIEW_ITEMS_QUERY_KEY });
  }
  if (moved("spend")) {
    void client.invalidateQueries({
      queryKey: ["dashboard", "personal-spend"],
    });
  }
  if (!conversationId) return;
  // The detail carries the token that it was built from, so this needs no
  // baseline. A live detail polls by itself.
  const detailKey = conversationDetailQueryKey(conversationId);
  const detail = client.getQueryState<ConversationSnapshot>(detailKey);
  if (
    !detail?.data ||
    detail.fetchStatus === "fetching" ||
    conversationDetailIsLive(detail.data)
  ) {
    return;
  }
  // Every server detail has a token. A token that is gone means the
  // Conversation is gone, and the refresh shows that.
  const token = detail.data.conversationVersion;
  if (token !== undefined && token !== next.conversation) {
    void client.invalidateQueries({ exact: true, queryKey: detailKey });
  }
}

/**
 * Poll one cheap change check for the whole tab, in place of separate polls
 * of the feed, spend, Review items, and the idle open Conversation.
 */
export function useVersionsPoll(
  conversationId: string | undefined,
  enabled: boolean,
) {
  const lastInputAtMs = useRef(Date.now());
  // The open Conversation changes the request, not the cached tokens, so it
  // stays out of the key. The detail token is compared with the detail.
  // oxlint-disable-next-line @tanstack/query/exhaustive-deps
  const { refetch } = useQuery({
    enabled,
    queryKey: VERSIONS_QUERY_KEY,
    queryFn: async ({ client, signal }) => {
      const previous = client.getQueryData<Versions>(VERSIONS_QUERY_KEY);
      const next = await fetchDashboardJson(
        versionsSchema,
        conversationId
          ? `/api/versions?${new URLSearchParams({ conversationId })}`
          : "/api/versions",
        signal,
      );
      refreshChangedReads(client, previous, next, conversationId);
      return next;
    },
    refetchInterval: () =>
      readerIsAway(lastInputAtMs.current) ? AWAY_POLL_MS : VERSIONS_POLL_MS,
    retry: false,
    // Hidden tabs do not poll. Check at once when the tab shows again.
    staleTime: 0,
  });
  useEffect(() => {
    const onInput = () => {
      const returned = readerIsAway(lastInputAtMs.current);
      lastInputAtMs.current = Date.now();
      // The next poll can be up to `AWAY_POLL_MS` away, so check now.
      if (returned && enabled) void refetch();
    };
    for (const type of READER_INPUT_EVENTS) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    return () => {
      for (const type of READER_INPUT_EVENTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
    };
  }, [enabled, refetch]);
}
