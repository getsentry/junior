import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { PanelLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  NavigationType,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { SearchInput } from "../components/SearchInput";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import { composerDockClass } from "./ComposerDock";
import { ConversationHomeList } from "./ConversationHomeList";
import {
  ConversationFeedLoadMore,
  type ConversationFeedMorePages,
} from "./ConversationFeedLoadMore";
import { ConversationVisibilitySelect } from "./ConversationVisibilitySelect";
import { useConversationActionToasts } from "./conversationActionToasts";
import { useConversationPageArchiveResult } from "./conversationArchive";
import {
  ConversationComposer,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import { HeaderIconButton } from "./ConversationHeaderActions";
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
import { FeedThreads, feedThreadsById } from "./feedThreads";
import { useWaitingConversations } from "../review-desk/queries";
import { UnsentAnswersProvider } from "../review-desk/UnsentAnswers";
import { useReorderPinnedConversations } from "./useReorderPinnedConversations";
import { HomeSummary } from "./HomeSummary";
import {
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH,
  useConversationSidebarOpen,
  useSidebarFits,
} from "./conversationSidebarLayout";

const SIDEBAR_PANEL_ID = "conversation-list";

/**
 * Render the conversation list beside the create view or one selected
 * conversation. Narrow screens without room for the list get a stacked home.
 */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
}) {
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useConversationSidebarOpen();
  // Home reports an archive that started on a conversation page. Do it here,
  // not in a list, because the list can be hidden.
  const { showArchiveError, showArchived } = useConversationActionToasts();
  useConversationPageArchiveResult(showArchived, showArchiveError);
  const sidebarFits = useSidebarFits();
  const sidebarPanel = useRef<PanelImperativeHandle>(null);
  const sidebarGroup = useRef<HTMLDivElement>(null);
  const sidebarId = useId();
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

  const homeConversations = useMemo(
    () => pinnedAndWaitingFirst(conversations, waitingConversations),
    [conversations, waitingConversations],
  );
  const homeList = useRef<HTMLDivElement>(null);
  // A new search starts at the top. Otherwise the shorter list leaves the
  // load-more row in view, and it loads a page before the results arrive.
  useEffect(() => {
    homeList.current?.scrollTo({ top: 0 });
  }, [search]);
  // A failed next page keeps the loaded rows; the load-more row shows it.
  const feedError = feed.isFetchNextPageError ? undefined : feed.error?.message;
  const morePages: ConversationFeedMorePages = {
    failed: feed.isFetchNextPageError,
    hasMore: feed.hasNextPage,
    loading: feed.isFetchingNextPage,
    onLoadMore: () => void feed.fetchNextPage({ cancelRefetch: false }),
  };

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
      onSubmit={async (message, idempotencyKey, visibility, files) => {
        const visit = homeVisit.current;
        const pendingDraftId = newConversationDraftId(idempotencyKey);
        // Show the Conversation at once. The create view stays mounted but
        // hidden, so a failed create comes back with the draft and its key.
        setPendingCreate({
          createdAt: new Date().toISOString(),
          idempotencyKey,
          files,
          message,
          visibility,
        });
        let accepted;
        try {
          accepted = await createConversation.mutateAsync({
            idempotencyKey,
            message,
            files,
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

  const toggleSidebar = () => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.resize(readSidebarWidth());
    else panel.collapse();
  };
  const sidebarToggle = (
    <HeaderIconButton
      controls={sidebarId}
      expanded={sidebarOpen}
      label={sidebarOpen ? "Hide conversation list" : "Show conversation list"}
      onClick={toggleSidebar}
    >
      <PanelLeft aria-hidden="true" size={15} strokeWidth={2} />
    </HeaderIconButton>
  );

  // One tree for every width, so the create draft and its files survive a
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
        <div className="flex h-13 items-center px-1">{sidebarToggle}</div>
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
              conversations={homeConversations}
              emptyLabel={feedError}
              loading={feed.isPending}
              // The first page holds every pin. Search shows only some pins,
              // so a drop could not place the rest.
              onReorderPins={search ? undefined : reorderPins}
              timeZone={getDashboardTimeZone()}
              waitingConversations={waitingConversations}
            />
            {feedError || conversations.length === 0 ? null : (
              <ConversationFeedLoadMore
                {...morePages}
                loadedCount={conversations.length}
              />
            )}
          </section>
        </div>
      )}
      <div
        className={
          sidebarFits
            ? // The tall bottom pad lifts the create view above the middle,
              // so the summary that hangs below it fits in the pane. Gutters
              // on both edges keep it centered when the summary grows enough
              // to show a scrollbar.
              "grid min-h-0 place-items-center overflow-y-auto overscroll-contain px-6 pb-48 [scrollbar-gutter:stable_both-edges]"
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
    <ResizablePanelGroup
      className="min-h-0 overflow-hidden bg-dashboard-bg"
      elementRef={sidebarGroup}
      onLayoutChanged={(layout) => {
        // Save after the drag ends. A drag that collapses the list passes
        // the minimum width first, and that width is not the reader's pick.
        const percent = layout[SIDEBAR_PANEL_ID] ?? 0;
        const groupWidth = sidebarGroup.current?.offsetWidth ?? 0;
        if (percent > 0) saveSidebarWidth((percent / 100) * groupWidth);
      }}
    >
      {sidebarFits ? (
        <>
          <ResizablePanel
            collapsible
            defaultSize={sidebarOpen ? readSidebarWidth() : 0}
            groupResizeBehavior="preserve-pixel-size"
            id={SIDEBAR_PANEL_ID}
            maxSize={`${SIDEBAR_WIDTH.max}rem`}
            minSize={`${SIDEBAR_WIDTH.min}rem`}
            onResize={(size) => {
              // Dragging past the minimum width collapses the list too, so the
              // panel size is the one source for the open state.
              const open = size.inPixels > 0;
              if (open !== sidebarOpen) setSidebarOpen(open);
            }}
            panelRef={sidebarPanel}
          >
            <div
              className={cn(
                "h-full min-h-0 overflow-hidden",
                !sidebarOpen && "hidden",
              )}
              id={sidebarId}
            >
              <ConversationSidebar
                conversations={conversations}
                error={feedError}
                loading={feed.isPending}
                morePages={morePages}
                onNewConversation={openCreate}
                onReorderPins={reorderPins}
                selectedId={selectedId}
                timeZone={getDashboardTimeZone()}
                waitingConversations={waitingConversations}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle
            aria-label="Resize conversation list"
            className="w-px bg-transparent transition-colors after:w-2 focus-visible:ring-dashboard-border-interactive data-[separator=active]:bg-dashboard-border-interactive data-[separator=hover]:bg-dashboard-border-interactive"
          />
        </>
      ) : null}
      <ResizablePanel id="selected-conversation">
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
                    sidebarToggle={sidebarToggle}
                  />
                </FeedThreads>
              </UnsentAnswersProvider>
            ) : pendingCreate ? (
              <NewConversationPending
                pending={pendingCreate}
                sidebarToggle={sidebarToggle}
              />
            ) : null}
          </section>
        ) : null}
      </ResizablePanel>
    </ResizablePanelGroup>
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
    files?: File[],
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");

  return (
    <section
      aria-label="New conversation"
      className="relative mx-auto grid w-full max-w-3xl gap-3"
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
          <ConversationVisibilitySelect
            onChange={setVisibility}
            value={visibility}
          />
        }
        label="Start a conversation"
        holdDraftUntilAccept
        ref={props.composerRef}
        submitLabel="Send"
        onSubmit={(message, idempotencyKey, files) =>
          props.onSubmit(message, idempotencyKey, visibility, files)
        }
      />
      {props.docked ? null : (
        // Hangs below the composer and takes no layout space, so the
        // composer stays centered while the summary loads.
        <div className="absolute inset-x-0 top-full pt-8">
          <HomeSummary />
        </div>
      )}
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
