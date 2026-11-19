import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  type Versions,
  VERSIONS_CONVERSATION_LIMIT,
  versionsSchema,
} from "@sentry/junior/api/schema";

import {
  type ConversationSnapshot,
  conversationDetailIsLive,
  conversationDetailQueryKey,
} from "./conversations/queries";
import { fetchDashboardJson } from "./http";
import { recordMovedVersions } from "./sentry";
import { REVIEW_ITEMS_QUERY_KEY } from "./review-desk/queries";
import { invalidateConversationFeeds } from "./conversations/conversationFeedCache";

const VERSIONS_QUERY_KEY = ["dashboard", "versions"] as const;

/** The tokens of the reads that every tab shows, whatever is open. */
const TAB_TOKENS = ["conversations", "reviewItems", "spend"] as const;

/**
 * The reads below refresh only when their token moves, so this interval is
 * the longest wait, for a reader who is present, before an idle
 * Conversation, the feed, the spend meter, or the Review count shows a
 * change.
 */
const VERSIONS_POLL_MS = 5_000;

/**
 * A reader with no input for this long is away: the tab can be visible on
 * another screen, but nobody acts on it.
 */
const AWAY_AFTER_MS = 5 * 60_000;

/** Poll interval while the reader is away. Input checks at once. */
const AWAY_POLL_MS = 10_000;

/**
 * Poll interval while the tab is hidden. It keeps the count in the tab title
 * and on the tab icon about a minute fresh, at a low cost.
 */
const HIDDEN_POLL_MS = 60_000;

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

/** Name the feed-row inputs whose `name:token` part differs between tokens. */
function movedFeedInputs(previous: string, next: string) {
  const before = new Set(previous.split(" "));
  return next
    .split(" ")
    .filter((part) => !before.has(part))
    .map((part) => part.split(":")[0] ?? part);
}

/**
 * List the Conversations whose idle detail is on screen, the open one first,
 * up to the cap of one read. A live detail polls by itself, and a detail
 * with no data has nothing to compare.
 */
function onScreenConversationIds(
  client: QueryClient,
  openConversationId: string | undefined,
) {
  const ids: string[] = [];
  for (const query of client.getQueryCache().findAll({
    queryKey: ["conversation"],
  })) {
    const [, conversationId, read] = query.queryKey;
    if (typeof conversationId !== "string" || read !== "detail") continue;
    const detail = client.getQueryData<ConversationSnapshot>(
      conversationDetailQueryKey(conversationId),
    );
    if (
      query.getObserversCount() === 0 ||
      !detail ||
      conversationDetailIsLive(detail)
    ) {
      continue;
    }
    if (conversationId === openConversationId) ids.unshift(conversationId);
    else ids.push(conversationId);
  }
  return ids.slice(0, VERSIONS_CONVERSATION_LIMIT);
}

/**
 * Read again each detail on screen whose last read failed. No timer polls
 * an idle detail, and a detail with no good read has no token to compare, so
 * this check is its retry.
 */
function retryFailedDetails(client: QueryClient) {
  for (const query of client.getQueryCache().findAll({
    queryKey: ["conversation"],
  })) {
    const [, conversationId, read] = query.queryKey;
    if (
      typeof conversationId !== "string" ||
      read !== "detail" ||
      query.getObserversCount() === 0 ||
      query.state.status !== "error" ||
      query.state.fetchStatus === "fetching"
    ) {
      continue;
    }
    void client.invalidateQueries({
      exact: true,
      queryKey: conversationDetailQueryKey(conversationId),
    });
  }
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
  conversationIds: readonly string[],
) {
  const moved = (field: (typeof TAB_TOKENS)[number]) =>
    previous !== undefined && previous[field] !== next[field];
  recordMovedVersions(
    TAB_TOKENS.filter(moved),
    previous && moved("conversations")
      ? movedFeedInputs(previous.conversations, next.conversations)
      : [],
  );
  // Waiting Conversations outside the newest page join the feed.
  if (moved("conversations") || moved("reviewItems")) {
    void invalidateConversationFeeds(client);
  }
  if (moved("reviewItems")) {
    // oxlint-disable-next-line query-invalidation/no-broad-query-invalidation -- The token does not say which item moved, and each row reads its own item.
    void client.invalidateQueries({ queryKey: REVIEW_ITEMS_QUERY_KEY });
  }
  if (moved("spend")) {
    void client.invalidateQueries({
      exact: true,
      queryKey: ["dashboard", "personal-spend"],
    });
  }
  // Each detail carries the token that it was built from, so this needs no
  // baseline.
  for (const conversationId of conversationIds) {
    const detailKey = conversationDetailQueryKey(conversationId);
    const detail = client.getQueryState<ConversationSnapshot>(detailKey);
    if (
      !detail?.data ||
      detail.fetchStatus === "fetching" ||
      conversationDetailIsLive(detail.data)
    ) {
      continue;
    }
    // Every server detail has a token. A token that is gone means the
    // Conversation is gone, and the refresh shows that.
    const token = detail.data.conversationVersion;
    if (
      token !== undefined &&
      token !== next.conversationDetails[conversationId]
    ) {
      void client.invalidateQueries({ exact: true, queryKey: detailKey });
    }
  }
}

/**
 * Poll one cheap change check for the whole tab, in place of separate polls
 * of the feed, spend, Review items, and each idle Conversation on screen.
 */
export function useVersionsPoll(
  conversationId: string | undefined,
  enabled: boolean,
) {
  const lastInputAtMs = useRef(Date.now());
  // The Conversations on screen change the request, not the cached tokens,
  // so they stay out of the key. Each detail token is compared with its
  // detail.
  // oxlint-disable-next-line @tanstack/query/exhaustive-deps
  const { refetch } = useQuery({
    enabled,
    queryKey: VERSIONS_QUERY_KEY,
    queryFn: async ({ client, signal }) => {
      const previous = client.getQueryData<Versions>(VERSIONS_QUERY_KEY);
      const conversationIds = onScreenConversationIds(client, conversationId);
      const next = await fetchDashboardJson(
        versionsSchema,
        conversationIds.length
          ? `/api/versions?${new URLSearchParams({ conversationIds: conversationIds.join(",") })}`
          : "/api/versions",
        signal,
      );
      refreshChangedReads(client, previous, next, conversationIds);
      retryFailedDetails(client);
      return next;
    },
    // oxlint-disable-next-line query-invalidation/no-refetch-interval -- The versions poll tells every other query when to refresh.
    refetchInterval: () =>
      document.visibilityState !== "visible"
        ? HIDDEN_POLL_MS
        : readerIsAway(lastInputAtMs.current)
          ? AWAY_POLL_MS
          : VERSIONS_POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
    // Check at once when the tab shows again.
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
