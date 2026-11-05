import type { InputImage } from "@sentry/junior/api/schema";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Globe2, LockKeyhole, PanelLeft } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { SearchInput } from "../components/SearchInput";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { pageCount, pageItems, PagePagination } from "../components/Pagination";
import { ConversationHomeList } from "./ConversationHomeList";
import { ConversationComposer } from "./ConversationComposer";
import { HeaderIconButton } from "./ConversationHeaderActions";
import {
  usePendingArchiveConversationUpdates,
  type PendingArchiveConversationUpdate,
} from "./conversationArchive";
import { useCreateConversation, type ConversationData } from "./queries";
import { prefetchConversationDetail } from "./conversationPrefetch";
import { conversationPath, NEW_CONVERSATION_PATH } from "./conversationRoutes";
import {
  attentionConversationIds,
  pinnedAndAttentionFirst,
} from "./conversationSections";
import { buildConversations, getDashboardTimeZone } from "../format";
import { useDebouncedValue } from "../debouncedValue";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationPage } from "./ConversationPage";
import {
  useWaitingConversationIds,
  useWaitingConversations,
} from "../review-desk/queries";
import { UnsentAnswersProvider } from "../review-desk/UnsentAnswers";
import { useConversationFinishedIndicators } from "./useConversationFinishedIndicators";
import {
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH,
  useConversationSidebarOpen,
  useSidebarFits,
} from "./conversationSidebarLayout";

const CONVERSATION_PAGE_SIZE = 20;
const SIDEBAR_PANEL_ID = "conversation-list";

/** Render the conversation home page or one selected conversation. */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useConversationSidebarOpen();
  const sidebarFits = useSidebarFits();
  const sidebarPanel = useRef<PanelImperativeHandle>(null);
  const sidebarGroup = useRef<HTMLDivElement>(null);
  const sidebarId = useId();
  const search = useDebouncedValue(query.trim());
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const feed = useConversationsData(search);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const queryClient = useQueryClient();
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
    if (selectedId) navigate(NEW_CONVERSATION_PATH);
  };

  const waitingConversations = useWaitingConversations();
  const waitingConversationIds = useWaitingConversationIds();
  const { finishedConversationIds, heldConversationId, markRead } =
    useConversationFinishedIndicators(
      conversations,
      selectedId,
      Boolean(feed.data),
      !search,
    );

  const totalPages = pageCount(conversations.length, CONVERSATION_PAGE_SIZE);
  const pagedConversations = useMemo(
    () =>
      pageItems(
        pinnedAndAttentionFirst(
          conversations,
          attentionConversationIds(
            waitingConversationIds,
            finishedConversationIds,
          ),
        ),
        page,
        CONVERSATION_PAGE_SIZE,
      ),
    [conversations, finishedConversationIds, page, waitingConversationIds],
  );
  useEffect(() => {
    setPage(1);
  }, [search]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const createView = (
    <NewConversationView
      error={
        createConversation.error
          ? "Could not create the conversation. Try again."
          : undefined
      }
      onSubmit={async (message, idempotencyKey, visibility, images) => {
        const accepted = await createConversation.mutateAsync({
          idempotencyKey,
          message,
          images,
          visibility,
        });
        // Open the Conversation with its transcript and composer, not a
        // skeleton. The draft stays on this page until the route changes, so
        // the message moves from the composer to the transcript at once.
        await prefetchConversationDetail(queryClient, accepted.conversationId);
        await navigate(conversationPath(accepted.conversationId), {
          flushSync: true,
        });
      }}
    />
  );

  if (home) {
    return (
      <main className="h-full min-h-0 w-full overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6">
        <div className="mx-auto grid w-full max-w-6xl gap-8">
          {createView}
          <section aria-label="Conversations" className="grid gap-3">
            <SearchInput
              className="w-full sm:ml-auto sm:w-72"
              label="Search your conversations"
              onChange={setQuery}
              placeholder="Search conversations…"
              value={query}
            />
            <ConversationHomeList
              conversations={pagedConversations}
              emptyLabel={feed.error?.message}
              finishedConversationIds={finishedConversationIds}
              loading={feed.isPending}
              timeZone={getDashboardTimeZone()}
              waitingConversationIds={waitingConversationIds}
            />
            <PagePagination
              className="pt-1"
              onPageChange={setPage}
              page={page}
              pageCount={totalPages}
              pageSize={CONVERSATION_PAGE_SIZE}
              total={conversations.length}
            />
          </section>
        </div>
      </main>
    );
  }

  const toggleSidebar = () => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.resize(readSidebarWidth());
    else panel.collapse();
  };

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
            maxSize={SIDEBAR_WIDTH.max}
            minSize={SIDEBAR_WIDTH.min}
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
                error={feed.error?.message}
                finishedConversationIds={finishedConversationIds}
                heldConversationId={heldConversationId}
                loading={feed.isPending}
                onNewConversation={openCreate}
                onQueryChange={setQuery}
                query={query}
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
        <section
          aria-label="Selected conversation"
          className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
        >
          <UnsentAnswersProvider conversationId={selectedId} key={selectedId}>
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
              onRead={markRead}
              pendingArchiveUpdate={pendingArchiveUpdates.find(
                (update) => update.conversationId === selectedId,
              )}
              sidebarToggle={
                <HeaderIconButton
                  controls={sidebarId}
                  expanded={sidebarOpen}
                  label={
                    sidebarOpen
                      ? "Hide conversation list"
                      : "Show conversation list"
                  }
                  onClick={toggleSidebar}
                >
                  <PanelLeft aria-hidden="true" size={15} strokeWidth={2} />
                </HeaderIconButton>
              }
            />
          </UnsentAnswersProvider>
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function NewConversationView(props: {
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
      <h2 className="m-0 text-center font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl">
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
  return [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}
