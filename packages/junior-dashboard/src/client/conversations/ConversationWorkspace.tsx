import type { InputImage } from "@sentry/junior/api/schema";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { ArrowLeft, Globe2, LockKeyhole } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  Link,
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router";

import { useConversationsData, useOlderConversationPages } from "../api";
import { InboxDataProvider } from "../review-desk/inboxData";
import { InboxList } from "../review-desk/InboxList";
import { useInboxReturnPath } from "../review-desk/inboxListState";
import { INBOX_VIEW_LABELS, inboxViewOfPath } from "../review-desk/inboxModel";
import { InboxNav } from "../review-desk/InboxNav";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
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
import { buildConversations } from "../format";
import { usePushNotificationsTip } from "../notifications/pushNotificationsTip";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationPage } from "./ConversationPage";
import { FeedThreads, feedThreadsById } from "./feedThreads";
import { UnsentAnswersProvider } from "../review-desk/UnsentAnswers";
import { useSidebarFits } from "./conversationSidebarLayout";
import { ListPane, PaneCollapsedControls } from "../components/layout/PaneNav";

/**
 * The Inbox: its entries in the pane, and in the main area the list of the
 * selected entry, one Conversation, or the composer that "+" opens. Phones
 * show one of these at a time: the entries, a list, then a Conversation.
 */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
  /** Asks and Automations need a viewer; signed out, only Conversations show. */
  signedIn: boolean;
}) {
  // Home reports an archive that started on a conversation page. Do it here,
  // not in a list, because the list can be hidden.
  const { showArchiveError, showArchived } = useConversationActionToasts();
  useConversationPageArchiveResult(showArchived, showArchiveError);
  const sidebarFits = useSidebarFits();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // "+" opens the composer in the main area; "/" is the Inbox list.
  const composing = location.pathname === NEW_CONVERSATION_PATH;
  const params = useParams();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const feed = useConversationsData();
  // Older feed pages load only when the list scrolls to its end.
  const older = useOlderConversationPages(feed.data?.nextCursor);
  const returnPath = useInboxReturnPath();
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const offerPushNotifications = usePushNotificationsTip();
  const [pendingCreate, setPendingCreate] = useState<PendingNewConversation>();
  // A pending create shows only on home. Leaving home ends it, whether the
  // route opened its Conversation or the reader went elsewhere.
  if (!home && pendingCreate) setPendingCreate(undefined);
  const queryClient = useQueryClient();
  const createComposer = useRef<ConversationComposerHandle>(null);
  const createRequested = useRef(false);
  const conversations = useMemo(() => {
    const first = feed.data?.conversations ?? [];
    const firstIds = new Set(first.map((row) => row.conversationId));
    // A Conversation with new activity moves to the first page, so an
    // older page can still hold it until it reloads.
    const rows = [
      ...first,
      ...older.conversations.filter((row) => !firstIds.has(row.conversationId)),
    ];
    return applyPendingArchiveUpdates(
      buildConversations(rows),
      pendingArchiveUpdates,
    );
  }, [feed.data?.conversations, older.conversations, pendingArchiveUpdates]);
  const feedPages = {
    hasMore: older.hasMore,
    loadingMore: older.loadingMore,
    loadMore: older.loadMore,
  };
  const openCreate = () => {
    createConversation.reset();
    if (!composing) {
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
    if (!home || !composing) return;
    const returned =
      (homeShown.current || navigationType === NavigationType.Push) &&
      !createRequested.current;
    homeShown.current = true;
    createRequested.current = false;
    if (returned && touchKeyboardMatches()) return;
    createComposer.current?.focus();
  }, [composing, home, navigationType]);

  const createView = (
    <NewConversationView
      composerRef={createComposer}
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

  // "+" opens this: the composer, alone in the main area.
  const homePane = (
    <main
      className={cn(
        "h-full min-h-0 w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden",
        pendingCreate ? "hidden" : "grid",
      )}
    >
      <div
        className={cn(
          "flex h-header items-center gap-1 pl-6",
          !sidebarFits && "hidden",
        )}
      >
        <PaneCollapsedControls />
        <BackToList />
      </div>
      {/* The bottom pad matches the header row, so the create view sits in
          the middle of the pane. */}
      <div className="grid min-h-0 place-items-center overflow-y-auto overscroll-contain px-4 pb-13 sm:px-6">
        {createView}
      </div>
    </main>
  );
  // On a phone, "/" lists the entries; each opens its list on its own page.
  const listPane =
    !sidebarFits && !searchParams.has("view") ? (
      <section aria-label="Inbox" className="relative h-full min-h-0">
        <InboxNav phone />
        <PhoneNewButton onClick={openCreate} />
      </section>
    ) : (
      <div className="relative h-full min-h-0">
        <InboxList
          error={feed.error?.message}
          loading={feed.isPending}
          phone={!sidebarFits}
        />
        {sidebarFits ? null : <PhoneNewButton onClick={openCreate} />}
      </div>
    );

  // Esc goes back to the list when nothing else takes it: open Details, a
  // menu or dialog, a docked question, or a text box. It runs first, in
  // the capture phase, because a focused tooltip stops Esc from bubbling.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [data-escape-scope]",
        ) ||
        document.querySelector(ESCAPE_OWNERS)
      )
        return;
      void navigate(returnPath);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigate, returnPath, selectedId]);

  return (
    <InboxDataProvider
      conversations={conversations}
      feed={feedPages}
      signedIn={props.signedIn}
    >
      <div className="flex h-full min-h-0 overflow-hidden bg-dashboard-bg">
        {/* The pane hides itself while the reader hides it, and keeps the
          list mounted so its scroll position stays. */}
        {sidebarFits ? (
          <ListPane
            newAction={{ label: "New conversation", onClick: openCreate }}
            tab="inbox"
          >
            <InboxNav selectedConversationId={selectedId} />
          </ListPane>
        ) : null}
        <div className="h-full min-h-0 min-w-0 flex-1">
          {home ? (composing ? homePane : listPane) : null}
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
                      listPath={returnPath}
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
                      sidebarToggle={
                        <span className="flex items-center gap-1">
                          <PaneCollapsedControls />
                          <BackToList />
                        </span>
                      }
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
    </InboxDataProvider>
  );
}

/** Back to the Inbox list the reader came from. Esc does the same. */
function BackToList() {
  const to = useInboxReturnPath();
  const view = inboxViewOfPath(to);
  return (
    <Link
      aria-keyshortcuts="Escape"
      aria-label={`Back to ${INBOX_VIEW_LABELS[view]}`}
      className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 font-sans text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      title="Back (Esc)"
      to={to}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {INBOX_VIEW_LABELS[view]}
    </Link>
  );
}

/** What takes Esc before Back while open: Details, menus, and dialogs. */
const ESCAPE_OWNERS =
  "[data-dashboard-modal], [data-escape-owner], [role='dialog'], [role='menu']";

/** On a phone, "+" floats over the bottom-right of the list. */
function PhoneNewButton(props: { onClick(): void }) {
  return (
    <button
      aria-label="New conversation"
      className="absolute right-4 bottom-5 grid size-14 place-items-center rounded-2xl bg-dashboard-accent text-2xl text-dashboard-text-inverse shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={props.onClick}
      type="button"
    >
      +
    </button>
  );
}

function NewConversationView(props: {
  composerRef: Ref<ConversationComposerHandle>;
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
): Conversation[] {
  // The optimistic cache write in useArchiveConversation sets archivedAt on
  // success too, ahead of the feed invalidation settling. Drop already-
  // archived rows here so they cannot reappear until the mutation leaves
  // "pending" but the stale cache has not refetched yet.
  const byId = new Map(
    conversations
      .filter((conversation) => !conversation.archivedAt)
      .map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
    if (update.archived) {
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
    byId.set(update.conversationId, { ...conversation, archivedAt: null });
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
  return archivedIds.size === 0
    ? rows
    : withoutThreads(rows, (thread) => archivedIds.has(thread.id));
}
