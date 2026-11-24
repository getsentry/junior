import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Versions,
  VERSIONS_CONVERSATION_LIMIT,
  VERSIONS_STREAM_HEADER,
  VERSIONS_STREAM_KEEPALIVE_EVENT,
  versionsSchema,
} from "@sentry/junior/api/schema";

import {
  type ConversationSnapshot,
  conversationDetailIsLive,
  conversationDetailQueryKey,
} from "./conversations/queries";
import { readDashboardResponse } from "./http";
import { readResponseJson, recordMovedVersions } from "./sentry";
import { INBOX_ITEMS_QUERY_KEY } from "./inbox/queries";
import { invalidateConversationFeeds } from "./conversations/conversationFeedCache";

const VERSIONS_QUERY_KEY = ["dashboard", "versions"] as const;

/** The tokens of the reads that every tab shows, whatever is open. */
const TAB_TOKENS = ["conversations", "inboxItems", "spend"] as const;

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

/**
 * Poll interval while the versions stream is healthy. The stream pushes each
 * change, so the poll is only a safety net.
 */
const STREAMING_POLL_MS = 60_000;

/**
 * A stream that sent nothing for this long is not healthy. The server sends a
 * keepalive each 15 s.
 */
const STREAM_STALE_MS = 30_000;

/**
 * After this many stream errors in a row with no open in between, the tab
 * polls at full speed and tries the stream again later. Each stream ends by
 * itself after about two minutes, which counts as one error before the
 * reconnect opens.
 */
const STREAM_MAX_FAILURES = 3;
const STREAM_RETRY_AFTER_MS = 5 * 60_000;

/** On-screen details settle for this long before the stream follows them. */
const STREAM_IDS_SETTLE_MS = 250;

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

function streamIsHealthy(lastStreamEventAtMs: number) {
  return Date.now() - lastStreamEventAtMs < STREAM_STALE_MS;
}

function versionsPath(path: string, conversationIds: readonly string[]) {
  return conversationIds.length
    ? `${path}?${new URLSearchParams({ conversationIds: conversationIds.join(",") })}`
    : path;
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
 * List the Conversations whose idle detail is on screen, up to the cap of one
 * read, with the open one kept when there are more. A live detail polls by
 * itself, and a detail with no data has nothing to compare. The ids are
 * sorted, so the same screen asks with the same URL.
 */
export function onScreenConversationIds(
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
  return ids.slice(0, VERSIONS_CONVERSATION_LIMIT).sort();
}

/**
 * Read again each detail on screen whose last read failed. No timer polls
 * an idle detail, and a detail with no good read has no token to compare, so
 * the poll and each stream event retry it here.
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
  if (moved("conversations") || moved("inboxItems")) {
    void invalidateConversationFeeds(client);
  }
  if (moved("inboxItems")) {
    // oxlint-disable-next-line query-invalidation/no-broad-query-invalidation -- The token does not say which item moved, and each row reads its own item.
    void client.invalidateQueries({ queryKey: INBOX_ITEMS_QUERY_KEY });
  }
  if (moved("spend")) {
    void client.invalidateQueries({
      exact: true,
      queryKey: ["dashboard", "personal-spend"],
    });
  }
  // Each detail carries the token that it was built from, so this needs no
  // baseline.
  let cardsMoved = false;
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
      cardsMoved = true;
    }
  }
  if (cardsMoved) {
    // oxlint-disable-next-line query-invalidation/no-broad-query-invalidation -- A moved Conversation can link work that changed, such as a pull request that merged, and the cards of its links read live.
    void client.invalidateQueries({ queryKey: ["object-links"] });
  }
}

/**
 * Keep the versions stream open while the tab shows, and apply each pushed
 * `Versions` like a poll result. The stream follows the details on screen:
 * when they change, it opens again with the new ids. `lastEventAtMs` holds
 * when the stream last spoke, 0 while it is closed. `onDown` runs when the
 * stream gives up, so the poll can speed up at once.
 */
function useVersionsStream(args: {
  conversationId: string | undefined;
  enabled: boolean;
  lastEventAtMs: RefObject<number>;
  onDown: () => void;
}) {
  const { conversationId, enabled, lastEventAtMs, onDown } = args;
  const client = useQueryClient();
  const [idsKey, setIdsKey] = useState(() =>
    onScreenConversationIds(client, conversationId).join(","),
  );
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () =>
      setIdsKey(onScreenConversationIds(client, conversationId).join(","));
    update();
    const unsubscribe = client.getQueryCache().subscribe(() => {
      clearTimeout(settle);
      settle = setTimeout(update, STREAM_IDS_SETTLE_MS);
    });
    return () => {
      clearTimeout(settle);
      unsubscribe();
    };
  }, [client, conversationId]);

  useEffect(() => {
    if (!blocked) return;
    const retry = setTimeout(() => setBlocked(false), STREAM_RETRY_AFTER_MS);
    return () => clearTimeout(retry);
  }, [blocked]);

  useEffect(() => {
    if (!enabled || blocked) return;
    const conversationIds = idsKey ? idsKey.split(",") : [];
    let source: EventSource | undefined;
    const close = () => {
      source?.close();
      source = undefined;
      lastEventAtMs.current = 0;
    };
    const open = () => {
      if (source) return;
      const opened = new EventSource(
        versionsPath("/api/versions/stream", conversationIds),
      );
      source = opened;
      let failures = 0;
      // The slow poll would wait up to a minute to read a failed detail
      // again, so each stream event, at least one per keepalive, retries it.
      const heard = () => {
        lastEventAtMs.current = Date.now();
        failures = 0;
        retryFailedDetails(client);
      };
      opened.addEventListener("open", heard);
      opened.addEventListener(VERSIONS_STREAM_KEEPALIVE_EVENT, heard);
      opened.addEventListener("message", (event: MessageEvent<string>) => {
        heard();
        const next = versionsSchema.safeParse(JSON.parse(event.data));
        if (!next.success) return;
        refreshChangedReads(
          client,
          client.getQueryData<Versions>(VERSIONS_QUERY_KEY),
          next.data,
          conversationIds,
        );
        client.setQueryData(VERSIONS_QUERY_KEY, next.data);
      });
      // A stream that ends at its cap fires `error` and reconnects. A refused
      // stream, such as a 204 when push is off, closes for good.
      opened.addEventListener("error", () => {
        failures += 1;
        if (
          opened.readyState !== EventSource.CLOSED &&
          failures < STREAM_MAX_FAILURES
        ) {
          return;
        }
        close();
        setBlocked(true);
        onDown();
      });
    };
    // Visibility opens and closes the stream here, not through state: a
    // render would reset the poll's timer, and a hidden tab still gets the
    // check that was due.
    const sync = () =>
      document.visibilityState === "visible" ? open() : close();
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      close();
    };
  }, [blocked, client, enabled, idsKey, lastEventAtMs, onDown]);
}

/**
 * Poll one cheap change check for the whole tab, in place of separate polls
 * of the feed, spend, Inbox items, and each idle Conversation on screen.
 * When the server can push the same tokens, a stream carries them and the
 * poll slows to a safety net. When the stream fails, the poll runs at full
 * speed again.
 */
export function useVersionsPoll(
  conversationId: string | undefined,
  enabled: boolean,
) {
  const lastInputAtMs = useRef(Date.now());
  const lastStreamEventAtMs = useRef(0);
  const [streamAvailable, setStreamAvailable] = useState(false);
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
      const response = await readDashboardResponse(
        versionsPath("/api/versions", conversationIds),
        signal,
      );
      const next = await readResponseJson(response, versionsSchema);
      setStreamAvailable(response.headers.get(VERSIONS_STREAM_HEADER) === "1");
      refreshChangedReads(client, previous, next, conversationIds);
      retryFailedDetails(client);
      return next;
    },
    // oxlint-disable-next-line query-invalidation/no-refetch-interval -- The versions poll tells every other query when to refresh.
    refetchInterval: () =>
      document.visibilityState !== "visible"
        ? HIDDEN_POLL_MS
        : streamIsHealthy(lastStreamEventAtMs.current)
          ? STREAMING_POLL_MS
          : readerIsAway(lastInputAtMs.current)
            ? AWAY_POLL_MS
            : VERSIONS_POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
    // Check at once when the tab shows again.
    staleTime: 0,
  });
  // `refetch` keeps its identity, so the stream does not open again.
  const pollNow = useCallback(() => void refetch(), [refetch]);
  useVersionsStream({
    conversationId,
    enabled: enabled && streamAvailable,
    lastEventAtMs: lastStreamEventAtMs,
    onDown: pollNow,
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
