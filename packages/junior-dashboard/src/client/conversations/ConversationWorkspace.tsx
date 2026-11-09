import type { InputImage } from "@sentry/junior/api/schema";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { Globe2, LockKeyhole } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router";

import { SearchInput } from "../components/SearchInput";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { pageCount, pageItems, PagePagination } from "../components/Pagination";
import { composerDockClass } from "./ComposerDock";
import { ConversationHomeList } from "./ConversationHomeList";
import { useConversationActionToasts } from "./conversationActionToasts";
import { useConversationPageArchiveResult } from "./conversationArchive";
import {
  ConversationComposer,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "./ConversationComposer";
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
  readCreateFocus,
} from "./conversationRoutes";
import {
  attentionConversationIds,
  pinnedAndAttentionFirst,
} from "./conversationSections";
import { getDashboardTimeZone } from "../format";
import { useDebouncedValue } from "../debouncedValue";
import { usePushNotificationsTip } from "../notifications/pushNotificationsTip";
import { cn } from "../styles";
import { ConversationPage } from "./ConversationPage";
import { FeedThreads, feedThreadsById } from "./feedThreads";
import { useWaitingConversationIds } from "../review-desk/queries";
import { UnsentAnswersProvider } from "../review-desk/UnsentAnswers";
import { useReorderPinnedConversations } from "./useReorderPinnedConversations";
import { useSidebarFits } from "./conversationSidebarLayout";
import { useConversationList } from "./useConversationList";

const CONVERSATION_PAGE_SIZE = 20;

/**
 * Render the create view or one selected conversation. The app sidebar lists
 * conversations beside it; narrow screens without the sidebar get a stacked
 * home list.
 */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
}) {
  const [page, setPage] = useState(1);
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
  const location = useLocation();
  const navigationType = useNavigationType();
  const selectedId = params.conversationId;
  const home = !selectedId;
  const { conversations, feed, pendingArchiveUpdates } =
    useConversationList(search);
  const reorderPins = useReorderPinnedConversations();
  const createConversation = useCreateConversation();
  const offerPushNotifications = usePushNotificationsTip();
  const [pendingCreate, setPendingCreate] = useState<PendingNewConversation>();
  // A pending create shows only on home. Leaving home ends it, whether the
  // route opened its Conversation or the reader went elsewhere.
  if (!home && pendingCreate) setPendingCreate(undefined);
  const queryClient = useQueryClient();
  const createComposer = useRef<ConversationComposerHandle>(null);
  // The sidebar's New conversation link asks home to focus the composer.
  const createRequested = readCreateFocus(location.state);
  const resetCreate = createConversation.reset;

  // Thread cards, breadcrumbs, and details show each Thread's own title and
  // status from its feed row.
  const feedThreads = useMemo(
    () => feedThreadsById(conversations),
    [conversations],
  );
  const waitingConversationIds = useWaitingConversationIds();

  const totalPages = pageCount(conversations.length, CONVERSATION_PAGE_SIZE);
  const pagedConversations = useMemo(
    () =>
      pageItems(
        pinnedAndAttentionFirst(
          conversations,
          attentionConversationIds(conversations, waitingConversationIds),
        ),
        page,
        CONVERSATION_PAGE_SIZE,
      ),
    [conversations, page, waitingConversationIds],
  );
  useEffect(() => {
    setPage(1);
  }, [search]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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
  // not when they come back from a conversation or follow a link. Each ask
  // is a new location, so asking again on home focuses again.
  const homeShown = useRef(false);
  useEffect(() => {
    if (!home) return;
    const returned =
      (homeShown.current || navigationType === NavigationType.Push) &&
      !createRequested;
    homeShown.current = true;
    if (createRequested) resetCreate();
    if (returned && touchKeyboardMatches()) return;
    createComposer.current?.focus();
  }, [createRequested, home, location.key, navigationType, resetCreate]);

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
          ? "grid-rows-[minmax(0,1fr)]"
          : "grid-rows-[minmax(0,1fr)_auto]",
      )}
    >
      {sidebarFits ? null : (
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3 pt-4 sm:px-6">
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
              loading={feed.isPending}
              // Search, or more pins than one page holds, shows only some
              // pins, so a drop could not place the rest.
              onReorderPins={
                search ||
                conversations.filter((conversation) => conversation.pinnedAt)
                  .length > CONVERSATION_PAGE_SIZE
                  ? undefined
                  : reorderPins
              }
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
      )}
      <div
        className={
          sidebarFits
            ? "grid min-h-0 place-items-center overflow-y-auto overscroll-contain px-6"
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg">
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
                />
              </FeedThreads>
            </UnsentAnswersProvider>
          ) : pendingCreate ? (
            <NewConversationPending pending={pendingCreate} />
          ) : null}
        </section>
      ) : null}
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
