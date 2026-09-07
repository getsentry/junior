import { useEffect, useMemo, useState } from "react";
import { Globe2, LockKeyhole } from "lucide-react";
import { useNavigate, useParams } from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { ToggleButton } from "../components/Button";
import { SearchInput } from "../components/SearchInput";
import { pageCount, pageItems, PagePagination } from "../components/Pagination";
import { ConversationHomeList } from "./ConversationHomeList";
import { ConversationComposer } from "./ConversationComposer";
import {
  useCreateConversation,
  usePendingArchiveConversationUpdates,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { conversationPath, NEW_CONVERSATION_PATH } from "./conversationRoutes";
import { buildConversations } from "../format";
import { filterConversationList } from "./conversationList";
import type { DashboardCoreData } from "../types";
import type { Conversation } from "../types";
import { cn, dashboardContainerClass } from "../styles";
import { ConversationPage } from "./ConversationPage";

const CONVERSATION_PAGE_SIZE = 20;

/** Render the conversation home page or one selected conversation. */
export function ConversationWorkspace(props: { data: DashboardCoreData }) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const feed = useConversationsData(status);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
      ),
    [feed.data?.conversations, pendingArchiveUpdates],
  );
  const visibleConversations = useMemo(
    () => filterConversationList(conversations, { query, status }),
    [conversations, query, status],
  );

  useEffect(() => {
    if (!home) return;
    // A new conversation starts in the active view.
    setStatus("active");
  }, [home]);

  const openCreate = () => {
    createConversation.reset();
    setStatus("active");
    if (selectedId) navigate(NEW_CONVERSATION_PATH);
  };

  const totalPages = pageCount(
    visibleConversations.length,
    CONVERSATION_PAGE_SIZE,
  );
  const pagedConversations = useMemo(
    () => pageItems(visibleConversations, page, CONVERSATION_PAGE_SIZE),
    [page, visibleConversations],
  );
  useEffect(() => {
    setPage(1);
  }, [query, status]);
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
      onSubmit={async (message, idempotencyKey, visibility) => {
        const accepted = await createConversation.mutateAsync({
          idempotencyKey,
          message,
          visibility,
        });
        navigate(conversationPath(accepted.conversationId));
      }}
    />
  );

  if (home) {
    return (
      <main
        className={cn(
          dashboardContainerClass,
          "h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 sm:py-8 xl:border-x xl:border-dashboard-border-subtle",
        )}
      >
        <div className="mx-auto grid w-full max-w-6xl gap-6">
          <header className="border-b border-dashboard-border-subtle pb-5">
            <h1 className="m-0 font-display text-3xl font-light tracking-[-0.03em] text-dashboard-text sm:text-4xl">
              Conversations
            </h1>
            <p className="mb-0 mt-2 font-mono text-xs text-dashboard-text-muted sm:text-sm">
              Start new work or review your recent conversations.
            </p>
          </header>
          {createView}
          <section
            aria-labelledby="conversation-list-title"
            className="grid gap-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2
                className="mr-auto font-display text-xl font-medium text-dashboard-text"
                id="conversation-list-title"
              >
                Your conversations
              </h2>
              <SearchInput
                className="w-full sm:w-72"
                label="Search your conversations"
                onChange={setQuery}
                placeholder="Search conversations…"
                value={query}
              />
              <div
                aria-label="Conversation status"
                className="flex gap-1"
                role="group"
              >
                <ToggleButton
                  onClick={() => setStatus("active")}
                  pressed={status === "active"}
                  variant="pill"
                >
                  Active
                </ToggleButton>
                <ToggleButton
                  onClick={() => setStatus("archived")}
                  pressed={status === "archived"}
                  variant="pill"
                >
                  Archived
                </ToggleButton>
              </div>
            </div>
            <ConversationHomeList
              conversations={pagedConversations}
              emptyLabel={feed.error?.message}
              timeZone={props.data.config.timeZone}
            />
            <PagePagination
              className="pt-1"
              onPageChange={setPage}
              page={page}
              pageCount={totalPages}
              pageSize={CONVERSATION_PAGE_SIZE}
              total={visibleConversations.length}
            />
          </section>
        </div>
      </main>
    );
  }

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
      )}
    >
      <div className="hidden h-full min-h-0 overflow-hidden md:block">
        <ConversationSidebar
          conversations={visibleConversations}
          error={feed.error?.message}
          loading={feed.isPending}
          onNewConversation={openCreate}
          onQueryChange={setQuery}
          onStatusChange={setStatus}
          query={query}
          selectedId={selectedId}
          status={status}
          timeZone={props.data.config.timeZone}
        />
      </div>
      <section
        aria-label="Selected conversation"
        className="grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-white/[0.012]"
      >
        <ConversationPage
          key={selectedId}
          conversationId={selectedId}
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
        />
      </section>
    </div>
  );
}

function NewConversationView(props: {
  error?: string;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const isPublic = visibility === "public";

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
          <div
            aria-label="Conversation visibility"
            className="inline-flex items-center gap-1"
            role="group"
          >
            <ToggleButton
              onClick={() => setVisibility("public")}
              pressed={isPublic}
              type="button"
              variant="segment"
            >
              <Globe2 aria-hidden="true" className="mr-1 inline size-3" />
              Public
            </ToggleButton>
            <ToggleButton
              onClick={() => setVisibility("private")}
              pressed={!isPublic}
              type="button"
              variant="segment"
            >
              <LockKeyhole aria-hidden="true" className="mr-1 inline size-3" />
              Private
            </ToggleButton>
          </div>
        }
        label="Start a conversation"
        restoreDraftOnError
        submitLabel="Send"
        onSubmit={(message, idempotencyKey) =>
          props.onSubmit(message, idempotencyKey, visibility)
        }
      />
    </section>
  );
}

function applyPendingArchiveUpdates(
  conversations: Conversation[],
  updates: PendingArchiveConversationUpdate[],
): Conversation[] {
  const byId = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
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
