import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSearchParams } from "react-router";
import type {
  ConversationDetailReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";

import {
  useArchiveConversation,
  useConversationData,
  type PendingArchiveConversationUpdate,
} from "./queries";
import { conversationIsResponding } from "./transcript";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyButton } from "../components/CopyButton";
import {
  CONVERSATION_EVENT_PARAM,
  CONVERSATION_REVIEW_OPEN,
  CONVERSATION_REVIEW_PARAM,
  CONVERSATION_TURN_PARAM,
  parseConversationEventSeq,
  turnStartedEventSeq,
} from "./conversationRoutes";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationReplyFooter } from "./ConversationReplyFooter";
import { ConversationDetails } from "./ConversationDetails";
import { turnPrompts } from "./ConversationMemories";
import {
  ConversationMemoryContext,
  memoryAnchorKey,
  useConversationMemories,
  type ConversationMemoryState,
  type OpenMemoryPopover,
} from "./conversationMemory";
import { ConversationEventDetails } from "./ConversationEventDetails";
import { ConversationEventLogLoading } from "./ConversationEventLog";
import {
  adjacentEventLogSeqs,
  eventLogRows,
  filterEventLogRows,
} from "./eventLog";
import { TranscriptSearchProvider } from "./transcriptSearch";
import {
  TurnContextDetails,
  type TurnContextPanel,
  type TurnContextSelection,
} from "./TranscriptTurnContextView";
import { cn } from "../styles";
import { ConversationForkLinks } from "./ConversationForkLinks";
import { ConversationAgentTree } from "./ConversationAgentTree";
import { conversationLinks } from "./ConversationLinkedWork";
import {
  ConversationAnnotations,
  conversationCost,
  conversationLocation,
  ConversationPrivacyChip,
  ConversationStats,
  hasConversationAnnotations,
  hasConversationStats,
} from "./ConversationMeta";
import {
  ConversationUsageBreakdown,
  hasConversationUsageBreakdown,
} from "./ConversationUsageBreakdown";
import {
  buildConversations,
  conversationDetailTitle,
  conversationDisplayTitle,
  conversationFromDetail,
  visualStatusForConversation,
} from "../format";
import { useDocumentTitle } from "../documentTitle";
import { Card } from "../components/layout/Card";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import { ChatLayout } from "./ChatLayout";
import {
  QuickQuestionPanel,
  QuickQuestionSelectionButton,
  useQuickQuestionThread,
} from "./QuickQuestion";
import { latestReviewItemId } from "../review-desk/reviewItemFormat";
import { Transcript } from "./TranscriptView";
import {
  readConversationStartPosition,
  useMarkConversationRead,
  useReadPositionAtOpen,
} from "./transcriptReadPosition";
import { TranscriptLoading } from "./TranscriptLoading";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "./SubagentTranscriptDrawer";
import type {
  Conversation,
  ConversationTranscript,
  TranscriptViewSubagentPart,
} from "../types";

export { liveModelId } from "./ConversationMeta";

const detailsDefaultOpenQuery = "(min-width: 1440px)";

function subscribeToDetailsLayout(onChange: () => void) {
  const media = window.matchMedia(detailsDefaultOpenQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Render the selected conversation transcript inside the workspace. */
export function ConversationPage(props: {
  conversationId: string;
  data?: { conversations: ConversationFeed };
  onRead?(conversationId: string, lastReadAt: string): void;
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
}) {
  const detailsDefaultOpen = useSyncExternalStore(
    subscribeToDetailsLayout,
    () => window.matchMedia(detailsDefaultOpenQuery).matches,
    () => false,
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const [subagentTarget, setSubagentTarget] =
    useState<SubagentTranscriptTarget>();
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL owns the open event log entry so readers can share that link.
  const selectedEventSeq = parseConversationEventSeq(
    searchParams.get(CONVERSATION_EVENT_PARAM),
  );
  // A linked Turn opens the event that started it. Until that event is
  // found, it acts like a linked event that is still loading.
  const linkedTurnId = searchParams.get(CONVERSATION_TURN_PARAM) ?? undefined;
  const eventOpen =
    selectedEventSeq !== undefined || linkedTurnId !== undefined;
  // Event details and turn context show over Conversation details. Closing
  // them shows details again when details are open. A linked event starts
  // with details closed, so closing it does not open a panel nobody chose.
  const [detailsChoice, setDetailsChoice] = useState<boolean | undefined>(() =>
    eventOpen ? false : undefined,
  );
  // A sidebar review chip links here with the review param. It opens
  // details at Needs you, even below the width where details open alone.
  const reviewOpen =
    searchParams.get(CONVERSATION_REVIEW_PARAM) === CONVERSATION_REVIEW_OPEN;
  useEffect(() => {
    if (reviewOpen) setDetailsChoice(true);
  }, [reviewOpen]);
  const detailsOpen = detailsChoice ?? (reviewOpen || detailsDefaultOpen);
  const closeDetails = useCallback(() => {
    setDetailsChoice(false);
    setSearchParams(
      (current) => {
        if (!current.has(CONVERSATION_REVIEW_PARAM)) return current;
        const next = new URLSearchParams(current);
        next.delete(CONVERSATION_REVIEW_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const [turnContext, setTurnContext] = useState<TurnContextSelection>();
  const [memoryPopover, setMemoryPopover] = useState<OpenMemoryPopover>();
  // A memory chosen in details waits here until its transcript row renders.
  const [memoryJump, setMemoryJump] = useState<OpenMemoryPopover>();
  // The page stays mounted across Conversations. Memory state belongs to one.
  const [memoryConversationId, setMemoryConversationId] = useState(
    props.conversationId,
  );
  if (memoryConversationId !== props.conversationId) {
    setMemoryConversationId(props.conversationId);
    setMemoryPopover(undefined);
    setMemoryJump(undefined);
  }
  const quickQuestion = useQuickQuestionThread(props.conversationId);
  // Event details and turn context also show over a Quick question.
  const showQuickQuestion =
    Boolean(quickQuestion.thread) && !eventOpen && !turnContext;
  const showDetails =
    detailsOpen && !eventOpen && !turnContext && !quickQuestion.thread;
  const [viewState, setView] = useState<TranscriptViewMode>(() =>
    eventOpen ? "raw" : "rich",
  );
  const view = eventOpen ? "raw" : viewState;
  const [search, setSearch] = useState("");
  const [pinRequestVersion, setPinRequestVersion] = useState(0);
  const conversationId = props.conversationId;
  const onRead = props.onRead;
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  const detail = useConversationData(conversationId);
  const memoryList = useConversationMemories(conversationId).data;
  const memoryState = useMemo<ConversationMemoryState>(
    () => ({
      list: memoryList,
      open: memoryPopover,
      setOpen: setMemoryPopover,
    }),
    [memoryList, memoryPopover],
  );
  const archive = useArchiveConversation(conversationId);
  const markRead = useMarkConversationRead(conversationId);
  const readAtOpen = useReadPositionAtOpen(detail.data, detail.fetchedDetail);
  const feedConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const conversation = applyPendingArchiveUpdate(
    conversationFromDetail(detail.data) ?? feedConversation,
    props.pendingArchiveUpdate,
  );
  const participants = conversationParticipants(conversation);
  const identity =
    participants.length > 0 ? (
      <ParticipantAvatarStack participants={participants} size="detail" />
    ) : null;
  const conversationDetail = detail.data;
  const title =
    conversationDetailTitle(detail.data) ??
    conversationDisplayTitle(conversation);
  useDocumentTitle(detail.data || conversation ? title : undefined);
  const agentTree = detail.data?.agentTree;
  useEffect(() => {
    if (!conversation) return;
    onRead?.(conversation.id, conversation.lastSeenAt);
  }, [conversation, onRead]);
  const transcript = detail.data;
  const selectedEvent =
    transcript?.eventHistory.status === "expired"
      ? undefined
      : transcript?.events.find((event) => event.seq === selectedEventSeq);
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;
  // History and mailbox use the same deferred server snapshot.
  const live = conversationIsLive(visualStatus, detail.data);
  // Key on the event array, not the whole detail object. Metadata-only polls
  // reuse events via structural sharing, so the footer keeps a stable id list.
  const mailboxCommittedIds = useMemo(
    () => committedMessageIds(detail.data?.events),
    [detail.data?.events],
  );
  const reviewItemId = useMemo(
    () => latestReviewItemId(detail.data?.events),
    [detail.data?.events],
  );
  // Cancel needs the latest mailbox watermark, but not as a render prop. Live
  // polls refresh generatedAt every 2s even when the queue is unchanged.
  const pendingGeneratedAtRef = useRef(detail.pendingGeneratedAt);
  pendingGeneratedAtRef.current = detail.pendingGeneratedAt;
  const setSelectedEventSeq = useCallback(
    (seq: number | undefined) => {
      // Keep the event log after close, even when a link opened the page.
      setView("raw");
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete(CONVERSATION_TURN_PARAM);
          if (seq === undefined) next.delete(CONVERSATION_EVENT_PARAM);
          else next.set(CONVERSATION_EVENT_PARAM, String(seq));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const onViewChange = useCallback(
    (value: TranscriptViewMode) => {
      if (value !== "raw" && eventOpen) {
        setSelectedEventSeq(undefined);
      }
      // Turn context belongs to a message in the Conversation view.
      setTurnContext(undefined);
      setView(value);
    },
    [eventOpen, setSelectedEventSeq],
  );
  // A linked event can be older than the first page. Load earlier pages until
  // it is present or history ends.
  const loadPreviousPageRef = useRef(detail.loadPreviousPage);
  loadPreviousPageRef.current = detail.loadPreviousPage;
  const oldestLoadedSeq = transcript?.events[0]?.seq;
  const linkedEventMissing =
    selectedEventSeq !== undefined &&
    oldestLoadedSeq !== undefined &&
    selectedEventSeq < oldestLoadedSeq;
  const loadLinkedEvent =
    linkedEventMissing &&
    detail.hasPreviousPage &&
    !detail.isLoadingPreviousPage &&
    !detail.historyError;
  useEffect(() => {
    if (loadLinkedEvent) loadPreviousPageRef.current();
  }, [loadLinkedEvent, oldestLoadedSeq]);
  // Load earlier pages until the linked Turn starts or history ends. Then
  // replace the Turn link with a link to its first event, or drop it when
  // history has no such event. A history error keeps the link, so a retry
  // or reload can still find the Turn.
  const linkedTurnSeq = linkedTurnId
    ? turnStartedEventSeq(transcript?.events, linkedTurnId)
    : undefined;
  const linkedTurnMissing =
    linkedTurnId !== undefined &&
    linkedTurnSeq === undefined &&
    transcript !== undefined;
  const loadLinkedTurn =
    linkedTurnMissing &&
    detail.hasPreviousPage &&
    !detail.isLoadingPreviousPage &&
    !detail.historyError;
  const linkedTurnNotFound =
    linkedTurnMissing &&
    !detail.hasPreviousPage &&
    !detail.isLoadingPreviousPage;
  useEffect(() => {
    if (loadLinkedTurn) loadPreviousPageRef.current();
  }, [loadLinkedTurn, oldestLoadedSeq]);
  useEffect(() => {
    if (linkedTurnSeq !== undefined) setSelectedEventSeq(linkedTurnSeq);
    else if (linkedTurnNotFound) setSelectedEventSeq(undefined);
  }, [linkedTurnNotFound, linkedTurnSeq, setSelectedEventSeq]);
  // Show a chosen memory at its transcript row. Wait for the first page, then
  // load earlier pages until the row renders, or stop when history ends.
  const memoryPrompts = useMemo(
    () => turnPrompts(transcript?.events),
    [transcript?.events],
  );
  useEffect(() => {
    if (!memoryJump || !transcript) return;
    const anchor = pageRef.current?.querySelector(
      `[data-memory-anchor="${CSS.escape(memoryAnchorKey(memoryJump))}"]`,
    );
    if (anchor) {
      anchor.scrollIntoView({ block: "center" });
      setMemoryPopover(memoryJump);
      setMemoryJump(undefined);
    } else if (
      detail.hasPreviousPage &&
      !detail.isLoadingPreviousPage &&
      !detail.historyError
    ) {
      loadPreviousPageRef.current();
    } else if (!detail.isLoadingPreviousPage) {
      setMemoryJump(undefined);
    }
  }, [
    detail.hasPreviousPage,
    detail.historyError,
    detail.isLoadingPreviousPage,
    memoryJump,
    transcript,
    view,
  ]);
  // Keep the panel while the transcript or a linked event loads, and for the
  // render before a found Turn link becomes an event link.
  const eventLoading =
    eventOpen &&
    !selectedEvent &&
    (detail.isPending ||
      linkedTurnSeq !== undefined ||
      ((linkedEventMissing || linkedTurnMissing) &&
        (detail.hasPreviousPage || detail.isLoadingPreviousPage) &&
        !detail.historyError));
  const showEvent = Boolean(selectedEvent) || eventLoading;
  // Step through the same filtered rows that the event log shows.
  const events = transcript?.events;
  const normalizedSearch = search.trim().toLowerCase();
  const eventRows = useMemo(
    () =>
      eventOpen && events
        ? filterEventLogRows(eventLogRows(events), normalizedSearch)
        : [],
    [eventOpen, events, normalizedSearch],
  );
  const turnContextPanel = useMemo<TurnContextPanel>(
    () => ({
      openId: turnContext?.id,
      onToggle: (selection) =>
        setTurnContext((current) =>
          current?.id === selection.id ? undefined : selection,
        ),
    }),
    [turnContext?.id],
  );
  const requestPin = useCallback(() => {
    setPinRequestVersion((version) => version + 1);
  }, []);
  const onOpenSubagentTranscript = useCallback(
    ({
      part,
    }: {
      part: TranscriptViewSubagentPart;
      conversation: ConversationTranscript;
    }) => {
      setSubagentTarget({
        ...(part.agentName ? { agentName: part.agentName } : undefined),
        conversationId: part.childConversationId,
        label: part.title ?? part.agentName,
        status: part.status,
      });
    },
    [],
  );

  const closeEventDetails = () => {
    const trigger = pageRef.current?.querySelector<HTMLButtonElement>(
      `[data-event-seq="${selectedEventSeq}"] button`,
    );
    setSelectedEventSeq(undefined);
    trigger?.focus({ preventScroll: true });
  };
  const closeTurnContext = () => {
    // A message can have one context control per layout. Focus the visible one.
    const trigger = [
      ...(pageRef.current?.querySelectorAll<HTMLButtonElement>(
        `[data-turn-context-id="${CSS.escape(turnContext?.id ?? "")}"]`,
      ) ?? []),
    ].find((button) => button.getClientRects().length > 0);
    setTurnContext(undefined);
    trigger?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={pageRef}
      className={cn(
        "grid h-full min-h-0 min-w-0",
        (showDetails || showEvent || turnContext || showQuickQuestion) &&
          "xl:grid-cols-[minmax(0,1fr)_25rem]",
      )}
    >
      <ChatLayout
        header={
          <ConversationHeader
            agentTree={
              agentTree ? <ConversationAgentTree nodes={agentTree} /> : null
            }
            conversationId={conversationId}
            cost={conversationCost(conversation, detail.data, "below")}
            detailsOpen={showDetails}
            onDetailsClick={() => {
              if (eventOpen) setSelectedEventSeq(undefined);
              setTurnContext(undefined);
              quickQuestion.close();
              if (showDetails) closeDetails();
              else setDetailsChoice(true);
            }}
            forks={
              detail.data?.forkedFromConversationId ||
              detail.data?.forks?.length ? (
                <ConversationForkLinks
                  forkedFromConversationId={
                    detail.data.forkedFromConversationId
                  }
                  forkedFromTitle={detail.data.forkedFromTitle}
                  forks={detail.data.forks}
                />
              ) : null
            }
            copyAction={
              <CopyButton
                label="Copy as Markdown"
                copyingLabel="Preparing Markdown"
                key={conversationDetail?.conversationId ?? "loading"}
                layout="menu"
                getText={
                  conversationDetail
                    ? async () =>
                        buildConversationMarkdown(
                          await detail.loadCompleteTranscript(),
                          conversation,
                        )
                    : undefined
                }
              />
            }
            linkedWork={
              hasConversationAnnotations(detail.data?.annotations) ? (
                <ConversationAnnotations detail={detail.data} />
              ) : null
            }
            archive={{
              archived: Boolean(conversation?.archivedAt),
              disabled: !conversation || archive.isPending,
              error: Boolean(archive.error),
              onClick: () =>
                archive.mutate({
                  archived: !conversation?.archivedAt,
                  lastSeenAt: conversation!.lastSeenAt,
                }),
              pending: archive.isPending,
            }}
            live={live}
            location={conversationLocation(conversation, detail.data)}
            onSearchChange={setSearch}
            onViewChange={onViewChange}
            privacy={
              <ConversationPrivacyChip visibility={conversation?.visibility} />
            }
            search={search}
            sentryConversationUrl={detail.data?.sentryConversationUrl}
            title={title}
            view={view}
          />
        }
        scrollMinTall
        scrollAriaLabel="Conversation transcript"
        scrollClassName={
          view === "raw" ? undefined : "px-4 pb-4 md:px-7 md:pb-6"
        }
        scroll={
          <section className="min-w-0">
            <div
              className={
                view === "raw"
                  ? "w-full"
                  : "mx-auto w-full max-w-[52.5rem] pt-5 md:pt-7"
              }
            >
              {detail.isPending ? (
                view === "raw" ? (
                  <ConversationEventLogLoading />
                ) : (
                  <TranscriptLoading />
                )
              ) : detail.error && !detail.data ? (
                <Card className="border-dashboard-border bg-dashboard-fill-soft p-4 font-sans text-xs leading-relaxed text-dashboard-text-muted">
                  {detail.error.message}
                </Card>
              ) : (
                <>
                  {detail.error ? (
                    <div className="mb-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.045] px-3 py-2 font-sans text-xs text-amber-100/65">
                      Transcript refresh failed. Showing the latest available
                      data.
                    </div>
                  ) : null}
                  <ConversationMemoryContext value={memoryState}>
                    <Transcript
                      hasPreviousPage={detail.hasPreviousPage}
                      historyError={detail.historyError}
                      historyVersion={detail.historyVersion}
                      lastReadSeq={readAtOpen.lastReadSeq}
                      live={live}
                      loadingPreviousPage={detail.isLoadingPreviousPage}
                      onLoadPreviousPage={detail.loadPreviousPage}
                      onRead={markRead}
                      onSelectedEventSeqChange={setSelectedEventSeq}
                      pendingMessages={detail.inlineMessages}
                      pinRequestVersion={pinRequestVersion}
                      responding={
                        !detail.error && conversationIsResponding(transcript)
                      }
                      onOpenSubagentTranscript={onOpenSubagentTranscript}
                      search={search}
                      onSearchChange={setSearch}
                      selectedEventSeq={selectedEventSeq}
                      startAtUnread={
                        readConversationStartPosition() === "unread"
                      }
                      transcript={transcript}
                      turnContextPanel={turnContextPanel}
                      unread={readAtOpen.unread}
                      view={view}
                    />
                  </ConversationMemoryContext>
                </>
              )}
            </div>
          </section>
        }
        dock={
          // A child Conversation takes input only from its parent agent, and it
          // runs without interactive auth, so it has no approval to show.
          view === "rich" && detail.data?.isParticipant && !agentTree ? (
            <ConversationReplyFooter
              authors={detail.data.authors}
              conversationId={conversationId}
              // Only pass committed ids for mailbox de-dupe. The full transcript is
              // too large to re-enter the footer on every live poll while typing.
              committedMessageIds={mailboxCommittedIds}
              onPinRequest={requestPin}
              pendingAuthorization={detail.pendingAuthorization}
              // Keep the cancel watermark off props. Live polls refresh generatedAt
              // every 2s; a prop would bust footer memo while the reader types.
              pendingGeneratedAtRef={pendingGeneratedAtRef}
              pendingMessages={detail.pendingMessages}
              reviewItemId={reviewItemId}
              // Without live history, an inline send would never leave the
              // transcript tail. A started Turn reads a new send only later.
              // Keep those sends in the queue. An earlier inline send that
              // history does not have yet can start that Turn first.
              sendsInline={
                detail.data.eventHistory.status === "available" &&
                !conversationIsResponding(detail.data) &&
                detail.inlineMessages.length === 0
              }
              stoppable={live}
            />
          ) : undefined
        }
      />
      {showDetails ? (
        <ConversationMemoryContext value={memoryState}>
          <ConversationDetails
            brief={detail.data?.brief}
            conversationId={conversationId}
            highlightReview={reviewOpen}
            identity={identity}
            onClose={closeDetails}
            onOpenSubagent={setSubagentTarget}
            memoryPrompts={memoryPrompts}
            onSelectMemory={(entry) => {
              // Memory rows show only in the Conversation view, and search
              // can hide them.
              if (view !== "rich") onViewChange("rich");
              setSearch("");
              setMemoryJump({
                memoryId: entry.memory.id,
                source: entry.source,
                turnId: entry.turnId,
              });
            }}
            links={conversationLinks(detail.data)}
            overview={
              hasConversationStats({
                conversation,
                detail: detail.data,
              }) ? (
                <ConversationStats
                  conversation={conversation}
                  detail={detail.data}
                />
              ) : null
            }
            usage={
              hasConversationUsageBreakdown({
                conversation,
                detail: detail.data,
              }) ? (
                <ConversationUsageBreakdown
                  conversation={conversation}
                  detail={detail.data}
                />
              ) : null
            }
          />
        </ConversationMemoryContext>
      ) : null}
      {showEvent ? (
        <ConversationEventDetails
          conversation={transcript}
          event={selectedEvent}
          onClose={closeEventDetails}
          onSelect={setSelectedEventSeq}
          {...adjacentEventLogSeqs(eventRows, selectedEventSeq)}
        />
      ) : null}
      {turnContext ? (
        <TranscriptSearchProvider query={search}>
          <TurnContextDetails
            actor={turnContext.actor}
            contexts={turnContext.contexts}
            key={turnContext.id}
            onClose={closeTurnContext}
            timestamp={turnContext.timestamp}
          />
        </TranscriptSearchProvider>
      ) : null}
      {showQuickQuestion && quickQuestion.thread ? (
        <QuickQuestionPanel
          conversationId={conversationId}
          error={quickQuestion.error}
          onClose={quickQuestion.close}
          onSubmit={quickQuestion.submit}
          pending={quickQuestion.pending}
          thread={quickQuestion.thread}
        />
      ) : null}
      {/* The answer's cost belongs to the Conversation, so only participants ask. */}
      {detail.data?.isParticipant ? (
        <QuickQuestionSelectionButton
          onAsk={(selection) => {
            if (eventOpen) setSelectedEventSeq(undefined);
            setTurnContext(undefined);
            quickQuestion.open(selection);
          }}
          rootRef={pageRef}
        />
      ) : null}
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
    </div>
  );
}

function applyPendingArchiveUpdate(
  conversation: Conversation | undefined,
  update: PendingArchiveConversationUpdate | undefined,
): Conversation | undefined {
  const updatedConversation =
    conversation ??
    (update?.conversation
      ? buildConversations([update.conversation])[0]
      : undefined);
  if (!updatedConversation || !update) return updatedConversation;
  return {
    ...updatedConversation,
    archivedAt: update.archived
      ? (updatedConversation.archivedAt ?? updatedConversation.lastSeenAt)
      : null,
  };
}

function conversationIsLive(
  visualStatus: ReturnType<typeof visualStatusForConversation> | undefined,
  detail: ConversationDetailReport | undefined,
): boolean {
  if (detail) return detail.status === "active";
  return visualStatus === "active";
}

function committedMessageIds(
  events: ConversationDetailReport["events"] | undefined,
): readonly string[] {
  if (!events) return EMPTY_MESSAGE_IDS;
  const ids: string[] = [];
  for (const event of events) {
    if (event.data.type === "message") ids.push(event.data.messageId);
  }
  return ids;
}

const EMPTY_MESSAGE_IDS: readonly string[] = [];
