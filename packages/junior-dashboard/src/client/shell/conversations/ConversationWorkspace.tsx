import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { ArrowLeft, Globe2, LockKeyhole } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import {
  Link,
  Navigate,
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router";

import { InboxList } from "../../inbox/InboxList";
import {
  useInboxReturnPath,
  useShowComposer,
} from "../../inbox/inboxListState";
import { InboxNav } from "../../inbox/InboxNav";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { useConversationActionToasts } from "../../conversations/conversationActionToasts";
import { useConversationPageArchiveResult } from "../../conversations/conversationArchive";
import {
  ConversationComposer,
  touchKeyboardMatches,
  type ConversationComposerHandle,
} from "../../conversations/ConversationComposer";
import { useInboxConversations } from "../../conversations/useInboxConversations";
import {
  useCreateConversation,
  type ConversationData,
} from "../../conversations/queries";
import { prefetchConversationDetail } from "../../conversations/conversationPrefetch";
import {
  newConversationDraftId,
  NewConversationPending,
  type PendingNewConversation,
} from "./NewConversationPending";
import {
  restoreStoredDraftText,
  takeStoredDraftText,
} from "../../conversations/ConversationComposer";
import {
  conversationPath,
  FOCUS_REPLY_STATE,
  readReplyFocus,
  COMPOSER_PATH,
} from "../../conversations/conversationRoutes";
import { usePushNotificationsTip } from "../../notifications/pushNotificationsTip";
import { cn } from "../../styles";
import { ConversationPage } from "./ConversationPage";
import { FeedThreads, feedThreadsById } from "../../conversations/feedThreads";
import { UnsentAnswersProvider } from "../../inbox/UnsentAnswers";
import { useSidebarFits } from "../../conversations/conversationSidebarLayout";
import {
  ListPane,
  PaneCollapsedControls,
} from "../../components/layout/PaneNav";
import {
  isOldAutomationsPath,
  isOldPullRequestsPath,
  oldPullRequestsTarget,
  returnPathLabel,
} from "../../components/layout/paneRows";
import { HomeSummary } from "./HomeSummary";

/**
 * The Inbox: its entries in the pane, and in the main area the list of the
 * selected entry, one Conversation, or the composer that "+" opens. Phones
 * show one of these at a time: the entries, a list, then a Conversation.
 */
export function ConversationWorkspace(props: {
  /** The selected Conversation's data, from the shell. */
  detail: ConversationData;
}) {
  // Home reports an archive that started on a conversation page. Do it here,
  // not in a list, because the list can be hidden.
  const { showArchiveError, showArchived } = useConversationActionToasts();
  useConversationPageArchiveResult(showArchived, showArchiveError);
  const sidebarFits = useSidebarFits();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // "+" opens the composer in the main area; "/" is the Inbox list.
  const composing = location.pathname === COMPOSER_PATH;
  const params = useParams();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const selectedId = params["conversationId"];
  const home = !selectedId;
  const { conversations, feed, pendingArchiveUpdates } =
    useInboxConversations();
  const returnPath = useInboxReturnPath();
  const createConversation = useCreateConversation();
  const offerPushNotifications = usePushNotificationsTip();
  const [pendingCreate, setPendingCreate] = useState<PendingNewConversation>();
  // A pending create shows only on home. Leaving home ends it, whether the
  // route opened its Conversation or the reader went elsewhere.
  if (!home && pendingCreate) setPendingCreate(undefined);
  const queryClient = useQueryClient();
  const createComposer = useRef<ConversationComposerHandle>(null);
  const openCreate = () => {
    createConversation.reset();
    if (!composing) void navigate(COMPOSER_PATH, { state: FOCUS_REPLY_STATE });
    else createComposer.current?.focus();
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

  // The composer exists to start a conversation, so the reader can type at
  // once. On a touch screen, focus opens the keyboard over the page. There,
  // focus only when the dashboard opens on the composer or "+" asks to type,
  // not when they come back or follow a link. "+" asks in the route state,
  // which the composer then clears, so a Back into it does not ask again.
  // The session remembers that it showed, across remounts.
  const showComposer = useShowComposer();
  const typeRequested = composing && Boolean(readReplyFocus(location.state));
  useEffect(() => {
    if (!home || !composing) return;
    const first = showComposer();
    const returned =
      (!first || navigationType === NavigationType.Push) && !typeRequested;
    if (typeRequested)
      void navigate(`${location.pathname}${location.search}`, {
        replace: true,
        state: null,
      });
    if (returned && touchKeyboardMatches()) return;
    createComposer.current?.focus();
  }, [
    composing,
    home,
    location.pathname,
    location.search,
    navigate,
    navigationType,
    showComposer,
    typeRequested,
  ]);

  const createView = (
    <NewConversationView
      composerRef={createComposer}
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
      {/* The tall bottom pad lifts the create view above the middle, so the
          summary that hangs below it fits in the pane. Gutters on both edges
          keep it centered when the summary grows enough to show a
          scrollbar. */}
      <div className="grid min-h-0 place-items-center overflow-y-auto overscroll-contain px-4 pb-48 [scrollbar-gutter:stable_both-edges] sm:px-6">
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
          // A failed next page keeps the loaded rows; its Retry row shows it.
          error={feed.isFetchNextPageError ? undefined : feed.error?.message}
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
      const target = event.target instanceof Element ? event.target : null;
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

  // The Automations bundle became its own page.
  if (isOldAutomationsPath(location))
    return <Navigate replace to="/automations" />;
  // Pull requests moved to Code, which opens on the viewer's own.
  if (isOldPullRequestsPath(location))
    return <Navigate replace to={oldPullRequestsTarget(location.search)} />;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-dashboard-bg">
      {/* The pane hides itself while the reader hides it, and keeps the
          list mounted so its scroll position stays. */}
      {sidebarFits ? (
        <ListPane
          newAction={{ label: "New conversation", onClick: openCreate }}
          scrollList="destinations"
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
  );
}

/** Back to the list the reader came from. Esc does the same. */
function BackToList() {
  const to = useInboxReturnPath();
  const label = returnPathLabel(to);
  return (
    <Link
      aria-keyshortcuts="Escape"
      aria-label={`Back to ${label}`}
      className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 font-sans text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      title="Back (Esc)"
      to={to}
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {label}
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
      className="absolute right-4 bottom-5 grid size-14 place-items-center rounded-md bg-dashboard-text-solid text-2xl text-dashboard-text-inverse focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={props.onClick}
      type="button"
    >
      +
    </button>
  );
}

function NewConversationView(props: {
  composerRef: Ref<ConversationComposerHandle>;
  error?: string | undefined;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
    files?: File[],
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const wide = useSidebarFits();

  return (
    <section
      aria-label="New conversation"
      className="relative mx-auto grid w-full max-w-3xl gap-3"
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
        onSubmit={(message, idempotencyKey, files) =>
          props.onSubmit(message, idempotencyKey, visibility, files)
        }
      />
      {wide ? (
        // Hangs below the composer and takes no layout space, so the
        // composer stays centered while the summary loads. Phones skip it.
        <div className="absolute inset-x-0 top-full pt-8">
          <HomeSummary />
        </div>
      ) : null}
    </section>
  );
}
