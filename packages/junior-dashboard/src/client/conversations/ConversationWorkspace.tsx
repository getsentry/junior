import type { InputImage } from "@sentry/junior/api/schema";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { Globe2, LockKeyhole } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  NavigationType,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { SearchInput } from "../components/SearchInput";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { composerDockClass } from "./ComposerDock";
import { ConversationHomeList } from "./ConversationHomeList";
import { useConversationActionToasts } from "./conversationActionToasts";
import { useConversationPageArchiveResult } from "./conversationArchive";
import {
  ConversationComposer,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import {
  usePendingArchiveConversationUpdates,
  withoutThreads,
  type PendingArchiveConversationUpdate,
} from "./conversationArchive";
import { useCreateConversation, type ConversationData } from "./queries";
import { prefetchConversationDetail } from "./conversationPrefetch";
import {
  newConversationDraftId,
  NewConversationPending,
  type PendingNewConversation,
} from "./NewConversationPending";
import {
  restoreStoredDraftText,
  takeStoredDraftText,
} from "./ConversationComposer";
import {
  conversationPath,
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
} from "./conversationRoutes";
import { pinnedAndWaitingFirst } from "./conversationSections";
import { buildConversations, getDashboardTimeZone } from "../format";
import { useDebouncedValue } from "../debouncedValue";
import { usePushNotificationsTip } from "../notifications/pushNotificationsTip";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationPage } from "./ConversationPage";
import { useAutoLoadHistoryPage } from "./transcriptBottomPinning";
import { FeedThreads, feedThreadsById } from "./feedThreads";
import { useWaitingConversations } from "../review-desk/queries";
import { UnsentAnswersProvider } from "../review-desk/UnsentAnswers";
import { useReorderPinnedConversations } from "./useReorderPinnedConversations";
import { useSidebarFits } from "./conversationSidebarLayout";
import { ListPane, PaneCollapsedControls } from "../components/layout/PaneNav";

const CONVERSATION_PAGE_SIZE = 20;

/**
 * Render the conversation list beside the create view or one selected
 * conversation. Narrow screens without room for the list get a stacked home.
 */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
}) {
  const [visibleCount, setVisibleCount] = useState(CONVERSATION_PAGE_SIZE);
  const [query, setQuery] = useState("");
  // Home reports an archive that started on a conversation page. Do it here,
  // not in a list, because the list can be hidden.
  const { showArchiveError, showArchived } = useConversationActionToasts();
  useConversationPageArchiveResult(showArchived, showArchiveError);
  const sidebarFits = useSidebarFits();
  // Only the stacked home has a search box. The sidebar lists every
  // conversation; the command palette searches them. Debounce only the typed
  // text, so the sidebar drops a stale search at once.
  const debouncedQuery = useDebouncedValue(query.trim());
  const search = sidebarFits ? "" : debouncedQuery;
  const params = useParams();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const feed = useConversationsData(search);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const reorderPins = useReorderPinnedConversations();
  const createConversation = useCreateConversation();
  const offerPushNotifications = usePushNotificationsTip();
  const [pendingCreate, setPendingCreate] = useState<PendingNewConversation>();
  // A pending create shows only on home. Leaving home ends it, whether the
  // route opened its Conversation or the reader went elsewhere.
  if (!home && pendingCreate) setPendingCreate(undefined);
  const queryClient = useQueryClient();
  const createComposer = useRef<ConversationComposerHandle>(null);
  const createRequested = useRef(false);
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
        Boolean(search),
      ),
    [feed.data?.conversations, pendingArchiveUpdates, search],
  );
  const openCreate = () => {
    createConversation.reset();
    if (selectedId) {
      // The reader asked to type, so home takes focus even on a touch screen.
      createRequested.current = true;
      navigate(NEW_CONVERSATION_PATH);
    } else createComposer.current?.focus();
  };

  // Thread cards, breadcrumbs, and details show each Thread's own title and
  // status from its feed row.
  const feedThreads = useMemo(
    () => feedThreadsById(conversations),
    [conversations],
  );
  const waitingConversations = useWaitingConversations();

  // The feed holds every row. The home list shows them a batch at a time
  // and shows the next batch when the reader scrolls near its end.
  const orderedConversations = useMemo(
    () => pinnedAndWaitingFirst(conversations, waitingConversations),
    [conversations, waitingConversations],
  );
  const visibleConversations = useMemo(
    () => orderedConversations.slice(0, visibleCount),
    [orderedConversations, visibleCount],
  );
  const hiddenCount = orderedConversations.length - visibleConversations.length;
  const homeList = useRef<HTMLDivElement>(null);
  // A new search starts at the top. Otherwise the shorter list leaves the
  // loader row in view, and it loads more before the results arrive.
  useEffect(() => {
    setVisibleCount(CONVERSATION_PAGE_SIZE);
    homeList.current?.scrollTo({ top: 0 });
  }, [search]);
  const loadMoreRef = useAutoLoadHistoryPage({
    edge: "bottom",
    enabled: hiddenCount > 0,
    historyVersion: String(visibleCount),
    onLoad: () => setVisibleCount((count) => count + CONVERSATION_PAGE_SIZE),
  });

  // Aborts when the reader leaves home, so a late create does not pull them
  // back from the page they went to.
  const homeVisit = useRef<AbortSignal>(undefined);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => {
    if (!home) return;
    const visit = new AbortController();
    homeVisit.current = visit.signal;
    return () => visit.abort();
  }, [home]);

  // Home exists to start a conversation, so the reader can type at once. On a
  // touch screen, focus opens the keyboard over the conversation list. There,
  // focus only when the dashboard opens on home or the reader asks to create,
  // not when they come back from a conversation or follow a link.
  const homeShown = useRef(false);
  useEffect(() => {
    if (!home) return;
    const returned =
      (homeShown.current || navigationType === NavigationType.Push) &&
      !createRequested.current;
    homeShown.current = true;
    createRequested.current = false;
    if (returned && touchKeyboardMatches()) return;
    createComposer.current?.focus();
  }, [home, navigationType]);

  const createView = (
    <NewConversationView
      composerRef={createComposer}
      docked={!sidebarFits}
      error={
        createConversation.error
          ? "Message failed to send. Try again."
          : undefined
      }
      onSubmit={async (message, idempotencyKey, visibility, images) => {
        const visit = homeVisit.current;
        const pendingDraftId = newConversationDraftId(idempotencyKey);
        // Show the Conversation at once. The create view stays mounted but
        // hidden, so a failed create comes back with the draft and its key.
        setPendingCreate({
          createdAt: new Date().toISOString(),
          idempotencyKey,
          images,
          message,
          visibility,
        });
        let accepted;
        try {
          accepted = await createConversation.mutateAsync({
            idempotencyKey,
            message,
            images,
            visibility,
          });
        } catch (error) {
          // Show home before the composer takes the failure, so it can
          // focus the draft for a retry. A reply typed meanwhile has no
          // Conversation to go to.
          flushSync(() => setPendingCreate(undefined));
          takeStoredDraftText(pendingDraftId);
          throw error;
        }
        // The page then opens with its transcript, not a skeleton. The
        // pending view stays until the route shows it.
        await prefetchConversationDetail(queryClient, accepted.conversationId);
        const left = visit?.aborted;
        if (left && selectedIdRef.current !== accepted.conversationId) {
          // The reply typed meanwhile waits in the new Conversation.
          restoreStoredDraftText(
            accepted.conversationId,
            takeStoredDraftText(pendingDraftId),
          );
          return;
        }
        // The reader may have opened the new Conversation already. Its
        // reply box is mounted then, so pass the draft through the route.
        await navigate(conversationPath(accepted.conversationId), {
          flushSync: true,
          replace: left,
          // The page's reply box takes focus and the text typed meanwhile.
          state: { ...FOCUS_REPLY_STATE, draftFrom: pendingDraftId },
        });
        offerPushNotifications();
      }}
    />
  );

  // One tree for every width, so the create draft and its images survive a
  // resize across the breakpoint: the create view is always the child of the
  // second div.
  const homePane = (
    <main
      className={cn(
        "h-full min-h-0 w-full overflow-hidden",
        pendingCreate ? "hidden" : "grid",
        sidebarFits
          ? "grid-rows-[auto_minmax(0,1fr)]"
          : "grid-rows-[minmax(0,1fr)_auto]",
      )}
    >
      {sidebarFits ? (
        <div className="flex h-12 items-center pl-6">
          <PaneCollapsedControls />
        </div>
      ) : (
        // The top space is inside the content, not the scroller's padding,
        // so the sticky section labels meet the page header.
        <div
          className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3 sm:px-6"
          ref={homeList}
        >
          <section aria-label="Conversations" className="grid gap-3 pt-4">
            <SearchInput
              className="w-full sm:ml-auto sm:w-72"
              label="Search your conversations"
              onChange={setQuery}
              placeholder="Search conversations…"
              value={query}
            />
            <ConversationHomeList
              conversations={visibleConversations}
              emptyLabel={feed.error?.message}
              loading={feed.isPending}
              // Search, or more pins than the list shows yet, shows only
              // some pins, so a drop could not place the rest.
              onReorderPins={
                search ||
                conversations.filter((conversation) => conversation.pinnedAt)
                  .length > visibleCount
                  ? undefined
                  : reorderPins
              }
              timeZone={getDashboardTimeZone()}
              waitingConversations={waitingConversations}
            />
            {hiddenCount > 0 ? (
              <div
                className="py-2 text-center font-sans text-xs text-dashboard-text-muted"
                ref={loadMoreRef}
                role="status"
              >
                Loading {Math.min(hiddenCount, CONVERSATION_PAGE_SIZE)} more…
              </div>
            ) : null}
          </section>
        </div>
      )}
      <div
        className={
          sidebarFits
            ? // The bottom pad matches the toggle row, so the create view
              // sits in the middle of the pane.
              "grid min-h-0 place-items-center overflow-y-auto overscroll-contain px-6 pb-13"
            : // Narrow screens dock the composer at the bottom, in thumb
              // reach.
              cn(
                composerDockClass,
                "overflow-y-auto border-t border-dashboard-border-subtle sm:px-6",
              )
        }
      >
        {createView}
      </div>
    </main>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-dashboard-bg">
      {/* The pane hides itself while the reader hides it, and keeps the
          list mounted so its scroll position stays. */}
      {sidebarFits ? (
        <ListPane onNewConversation={openCreate}>
          <ConversationSidebar
            conversations={conversations}
            error={feed.error?.message}
            loading={feed.isPending}
            onReorderPins={reorderPins}
            selectedId={selectedId}
            timeZone={getDashboardTimeZone()}
            waitingConversations={waitingConversations}
          />
        </ListPane>
      ) : null}
      <div className="h-full min-h-0 min-w-0 flex-1">
        {home ? homePane : null}
        {/* A pending create shows in the same section as the page that
            replaces it, so the swap keeps this element. */}
        {selectedId || pendingCreate ? (
          <section
            aria-busy={home || undefined}
            aria-label="Selected conversation"
            className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
          >
            {selectedId ? (
              <UnsentAnswersProvider
                conversationId={selectedId}
                key={selectedId}
              >
                <FeedThreads value={feedThreads}>
                  <ConversationPage
                    conversationId={selectedId}
                    detail={props.detail}
                    data={
                      feed.data
                        ? {
                            conversations: feed.data,
                          }
                        : undefined
                    }
                    pendingArchiveUpdate={pendingArchiveUpdates.find(
                      (update) => update.conversationId === selectedId,
                    )}
                    sidebarToggle=<PaneCollapsedControls />
                  />
                </FeedThreads>
              </UnsentAnswersProvider>
            ) : pendingCreate ? (
              <NewConversationPending
                pending={pendingCreate}
                sidebarToggle=<PaneCollapsedControls />
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function NewConversationView(props: {
  composerRef: Ref<ConversationComposerHandle>;
  /** Docked at the bottom of the narrow home, where the list is above it. */
  docked: boolean;
  error?: string;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
    images?: InputImage[],
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");

  return (
    <section
      aria-label="New conversation"
      className="mx-auto grid w-full max-w-3xl gap-3"
    >
      <h2
        className={cn(
          "m-0 text-center font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl",
          props.docked && "sr-only",
        )}
      >
        What do you need?
      </h2>
      <ConversationComposer
        draftId="new"
        error={props.error}
        footerStart={
          <ToggleGroup
            aria-label="Conversation visibility"
            className="inline-flex shrink-0 gap-0.5 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-0.5"
            onValueChange={([next]) => {
              if (next) setVisibility(next);
            }}
            value={[visibility]}
          >
            <ToggleGroupItem className="min-w-20 gap-1.5" value="public">
              <Globe2 aria-hidden="true" className="size-3" />
              Public
            </ToggleGroupItem>
            <ToggleGroupItem className="min-w-20 gap-1.5" value="private">
              <LockKeyhole aria-hidden="true" className="size-3" />
              Private
            </ToggleGroupItem>
          </ToggleGroup>
        }
        label="Start a conversation"
        holdDraftUntilAccept
        ref={props.composerRef}
        submitLabel="Send"
        onSubmit={(message, idempotencyKey, images) =>
          props.onSubmit(message, idempotencyKey, visibility, images)
        }
      />
    </section>
  );
}

function applyPendingArchiveUpdates(
  conversations: Conversation[],
  updates: PendingArchiveConversationUpdate[],
  includeArchived: boolean,
): Conversation[] {
  // The optimistic cache write in useArchiveConversation sets archivedAt on
  // success too, ahead of the feed invalidation settling. Drop already-
  // archived rows here so they cannot reappear until the mutation leaves
  // "pending" but the stale cache has not refetched yet.
  const byId = new Map(
    conversations
      .filter((conversation) => includeArchived || !conversation.archivedAt)
      .map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
    if (update.archived && !includeArchived) {
      byId.delete(update.conversationId);
      continue;
    }
    const existing = byId.get(update.conversationId);
    const conversation =
      existing ??
      (update.conversation
        ? buildConversations([update.conversation])[0]
        : undefined);
    if (!conversation) continue;
    byId.set(update.conversationId, {
      ...conversation,
      archivedAt: update.archived
        ? (conversation.archivedAt ?? conversation.lastSeenAt)
        : null,
    });
  }
  const rows = [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
  // A refetch can bring back a Thread whose archive is still pending.
  const archivedIds = new Set(
    updates
      .filter((update) => update.archived)
      .map((update) => update.conversationId),
  );
  // Keep row identity when nothing is pending, so memoized rows skip renders.
  return includeArchived || archivedIds.size === 0
    ? rows
    : withoutThreads(rows, (thread) => archivedIds.has(thread.id));
}
