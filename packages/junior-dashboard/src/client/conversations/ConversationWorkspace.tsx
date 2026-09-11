import { useDeferredValue, useEffect, useMemo, useState } from "react";
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
import { buildConversations, getDashboardTimeZone } from "../format";
import type { Conversation } from "../types";
import { cn, dashboardContainerClass } from "../styles";
import { ConversationPage } from "./ConversationPage";
import { useConversationFinishedIndicators } from "./useConversationFinishedIndicators";

const CONVERSATION_PAGE_SIZE = 20;

/** Render the conversation home page or one selected conversation. */
export function ConversationWorkspace() {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim());
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const feed = useConversationsData(search);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
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

  const totalPages = pageCount(conversations.length, CONVERSATION_PAGE_SIZE);
  const pagedConversations = useMemo(
    () => pageItems(conversations, page, CONVERSATION_PAGE_SIZE),
    [conversations, page],
  );
  useEffect(() => {
    setPage(1);
  }, [search]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const { finishedConversationIds, markRead } =
    useConversationFinishedIndicators(
      conversations,
      selectedId,
      Boolean(feed.data),
      !search,
    );

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
          "h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-6 xl:border-x xl:border-dashboard-border-subtle",
        )}
      >
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

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
      )}
    >
      <div className="hidden h-full min-h-0 overflow-hidden md:block">
        <ConversationSidebar
          conversations={conversations}
          error={feed.error?.message}
          finishedConversationIds={finishedConversationIds}
          loading={feed.isPending}
          onNewConversation={openCreate}
          onQueryChange={setQuery}
          query={query}
          selectedId={selectedId}
          timeZone={getDashboardTimeZone()}
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
          onRead={markRead}
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
