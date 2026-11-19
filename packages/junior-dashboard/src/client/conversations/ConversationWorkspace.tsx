import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
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
import { useAppendConversationMessage, type ConversationData } from "./queries";
import {
  conversationPath,
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
} from "./conversationRoutes";
import { pinnedAndWaitingFirst } from "./conversationSections";
import { buildConversations } from "../format";
import { useDebouncedValue } from "../debouncedValue";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationPage } from "./ConversationPage";
import { FeedThreads, feedThreadsById } from "./feedThreads";
import { useWaitingConversations } from "../inbox/queries";
import { UnsentAnswersProvider } from "../inbox/UnsentAnswers";
import { useReorderPinnedConversations } from "./useReorderPinnedConversations";
import { LoadingView } from "../components/LoadingView";
import { LeadLink, useLead } from "./Lead";
import {
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH,
  useConversationSidebarOpen,
  useSidebarFits,
} from "./conversationSidebarLayout";
import { getDashboardTimeZone } from "../time";

const SIDEBAR_PANEL_ID = "conversation-list";

/**
 * Render the conversation list beside one selected conversation. Home shows
 * the viewer's Lead. Narrow screens without room for the list get a stacked
 * home: the list above a reply box that sends to the Lead.
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
  const routeId = params["conversationId"];
  const home = !routeId;
  // New work goes through the Lead, so the wide home is the Lead itself.
  const lead = useLead(home);
  const leadId = lead.data?.conversationId;
  const selectedId = routeId ?? (sidebarFits ? leadId : undefined);
  const sendToLead = useAppendConversationMessage(leadId ?? "");
  const feed = useConversationsData(search);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const reorderPins = useReorderPinnedConversations();
  const homeComposer = useRef<ConversationComposerHandle>(null);
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
        Boolean(search),
      ),
    [feed.data?.conversations, pendingArchiveUpdates, search],
  );
  // Only the wide layout has the sidebar and its button. Home shows the Lead,
  // and its reply box takes focus.
  const openCreate = () => {
    void navigate(NEW_CONVERSATION_PATH, {
      replace: home,
      state: FOCUS_REPLY_STATE,
    });
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
  // A failed refresh or next page keeps the loaded rows. The load-more row
  // shows a failed next page.
  const feedError = feed.data ? undefined : feed.error?.message;
  const morePages: ConversationFeedMorePages = {
    failed: feed.isFetchNextPageError,
    hasMore: feed.hasNextPage,
    loading: feed.isFetchingNextPage,
    onLoadMore: () => void feed.fetchNextPage({ cancelRefetch: false }),
  };

  // The narrow home exists to ask the Lead, so the reader can type at once.
  // On a touch screen, focus opens the keyboard over the conversation list.
  // There, focus only when the dashboard opens on home, not when they come
  // back from a conversation or follow a link.
  const homeShown = useRef(false);
  useEffect(() => {
    if (!home) return;
    const returned =
      homeShown.current || navigationType === NavigationType.Push;
    homeShown.current = true;
    if (returned && touchKeyboardMatches()) return;
    homeComposer.current?.focus();
  }, [home, navigationType]);

  const leadComposer = (
    <ConversationComposer
      draftId="new"
      error={
        sendToLead.error ? "Message failed to send. Try again." : undefined
      }
      label="Message your Lead"
      holdDraftUntilAccept
      ref={homeComposer}
      submitLabel="Send"
      onSubmit={async (message, idempotencyKey, files) => {
        if (!leadId) throw new Error("Your Lead is still loading.");
        await sendToLead.mutateAsync({ idempotencyKey, message, files });
        // The Lead's reply box takes focus for the next message.
        await navigate(conversationPath(leadId), {
          state: FOCUS_REPLY_STATE,
        });
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

  // Only the narrow home shows this pane. The top space is inside the
  // content, not the scroller's padding, so the sticky section labels meet
  // the page header.
  const homePane = (
    <main className="grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <div
        className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3 sm:px-6"
        ref={homeList}
      >
        <section aria-label="Conversations" className="grid gap-3 pt-4">
          <div className="flex items-center gap-2">
            <LeadLink />
            <SearchInput
              className="min-w-0 flex-1 sm:ml-auto sm:w-72 sm:flex-none"
              label="Search your conversations"
              onChange={setQuery}
              placeholder="Search conversations…"
              value={query}
            />
          </div>
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
      {/* Narrow screens dock the composer at the bottom, in thumb reach. */}
      <div
        className={cn(
          composerDockClass,
          "overflow-y-auto border-t border-dashboard-border-subtle sm:px-6",
        )}
      >
        <div className="mx-auto grid w-full max-w-3xl">{leadComposer}</div>
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
        {home && !sidebarFits ? homePane : null}
        {selectedId ? (
          <section
            aria-label="Selected conversation"
            className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
          >
            <UnsentAnswersProvider conversationId={selectedId} key={selectedId}>
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
          </section>
        ) : home && sidebarFits ? (
          <LoadingView
            label={lead.error ? lead.error.message : "Loading your Lead"}
          />
        ) : null}
      </ResizablePanel>
    </ResizablePanelGroup>
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
