import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type {
  ConversationDetailReport,
  ConversationFeed,
} from "@sentry/junior/api/schema";

import type { ConversationData } from "./queries";
import { ConversationSidePanelLayout } from "./ConversationSidePanelLayout";
import {
  applyPendingArchiveUpdate,
  useArchiveConversation,
  type ArchivedFromConversationState,
  type PendingArchiveConversationUpdate,
} from "./conversationArchive";
import { usePinConversation } from "./usePinConversation";
import { useMarkConversationUnread } from "./useMarkConversationUnread";
import { conversationIsResponding, isChildConversation } from "./transcript";
import {
  ConversationCatchUpContext,
  useConversationCatchUp,
} from "./conversationCatchUpState";
import { buildConversationMarkdown } from "../markdownExport";
import { CopyButton } from "../components/CopyButton";
import {
  CONVERSATION_EVENT_PARAM,
  CONVERSATION_REVIEW_OPEN,
  CONVERSATION_REVIEW_PARAM,
  CONVERSATION_TURN_PARAM,
  parseConversationEventSeq,
  requestsReplyFocus,
  turnStartedEventSeq,
} from "./conversationRoutes";
import { ConversationHeader } from "./ConversationHeader";
import { ContinueInSlackDialog } from "./ContinueInSlackDialog";
import { ConversationPageDock } from "./ConversationPageDock";
import { ConversationDetailsPanel } from "./ConversationDetailsPanel";
import {
  ConversationMemoryContext,
  memoryAnchorKey,
  useConversationMemories,
  type ConversationMemoryState,
  type MemoryJump,
  type OpenMemoryPopover,
} from "./conversationMemory";
import { ConversationEventDetails } from "./ConversationEventDetails";
import { ConversationEventLogLoading } from "./ConversationEventLog";
import {
  adjacentEventLogSeqs,
  eventLogRows,
  filterEventLogRows,
} from "./eventLog";
import {
  TranscriptSearchProvider,
  useTranscriptSearchMatch,
} from "./transcriptSearch";
import {
  TurnContextDetails,
  type TurnContextPanel,
  type TurnContextSelection,
} from "./TranscriptTurnContextView";
import { cn } from "../styles";
import { DashboardApiError } from "../http";
import { ConversationForkLinks } from "./ConversationForkLinks";
import { ConversationAgentTree } from "./ConversationAgentTree";
import { conversationContextTags } from "./ConversationContextTags";
import { conversationLinks } from "./ConversationLinkedWork";
import {
  ConversationAnnotations,
  conversationCost,
  ConversationPrivacyChip,
} from "./ConversationMeta";
import {
  buildConversations,
  conversationDetailTitle,
  conversationDisplayTitle,
  conversationFromDetail,
  isIdleConversation,
  visualStatusForConversation,
} from "../format";
import { useDocumentTitle } from "../documentTitle";
import { Card } from "../components/layout/Card";
import { useRegisterMobileHeaderBack } from "../components/layout/DashboardChrome";
import { ArchiveChildDialog } from "./ArchiveChildDialog";
import { ChatLayout } from "./ChatLayout";
import type { ConversationComposerHandle } from "./ConversationComposer";
import { ConversationOutline } from "./ConversationOutline";
import {
  QuickQuestionPanel,
  QuickQuestionSelectionButton,
  useQuickQuestionThread,
} from "./QuickQuestion";
import { Transcript } from "./TranscriptView";
import {
  readConversationStartPosition,
  useMarkConversationRead,
  useReadPositionAtOpen,
} from "./transcriptReadPosition";
import { TranscriptLoading } from "./TranscriptLoading";
import { recordTranscriptShown } from "../sentry";
import {
  unheldLinkStart,
  useHistoryAround,
  type ConversationLink,
  type TranscriptHistory,
} from "./transcriptAroundHistory";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  SubagentTranscriptDrawer,
  type SubagentTranscriptTarget,
} from "./SubagentTranscriptDrawer";
import type {
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
  /**
   * This Conversation's data. The shell fetches it, so a direct load does
   * not wait for the dashboard core reads, and each visit fetches it once.
   */
  detail: ConversationData;
  pendingArchiveUpdate?: PendingArchiveConversationUpdate;
  sidebarToggle?: ReactNode;
}) {
  const detailsDefaultOpen = useSyncExternalStore(
    subscribeToDetailsLayout,
    () => window.matchMedia(detailsDefaultOpenQuery).matches,
    () => false,
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<Pick<ConversationComposerHandle, "appendText">>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusDetailsOnOpen = useRef(false);
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
  const [memoryJump, setMemoryJump] = useState<MemoryJump>();
  // The transcript mounts only rows near the viewport. The rows of the last
  // memory or outline jump stay mounted, so the jump finds its row and the
  // popover keeps it.
  const [revealSeq, setRevealSeq] = useState<number>();
  // The page stays mounted across Conversations. Memory state belongs to one.
  const [memoryConversationId, setMemoryConversationId] = useState(
    props.conversationId,
  );
  if (memoryConversationId !== props.conversationId) {
    setMemoryConversationId(props.conversationId);
    setMemoryPopover(undefined);
    setMemoryJump(undefined);
    setRevealSeq(undefined);
  }
  const quickQuestion = useQuickQuestionThread(props.conversationId);
  // Event details and turn context also show over a Quick question.
  const showQuickQuestion =
    Boolean(quickQuestion.thread) && !eventOpen && !turnContext;
  const showDetails =
    detailsOpen && !eventOpen && !turnContext && !quickQuestion.thread;
  useLayoutEffect(() => {
    if (!showDetails || !focusDetailsOnOpen.current) return;
    focusDetailsOnOpen.current = false;
    // The inline opener leaves the tab order while details are visible.
    pageRef.current
      ?.querySelector<HTMLButtonElement>('[data-slot="details-panel-close"]')
      ?.focus({ preventScroll: true });
  }, [showDetails]);
  const [viewState, setView] = useState<TranscriptViewMode>(() =>
    eventOpen ? "raw" : "rich",
  );
  const view = eventOpen ? "raw" : viewState;
  const [search, setSearch] = useState("");
  const searchMatch = useTranscriptSearchMatch(search);
  const [continueInSlackOpen, setContinueInSlackOpen] = useState(false);
  const [pinRequestVersion, setPinRequestVersion] = useState(0);
  const conversationId = props.conversationId;
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  // The page keeps the start preference from when the Conversation opened.
  const [startAtUnread] = useState(
    () => readConversationStartPosition() === "unread",
  );
  // A link at open shows its row, so the transcript does not open at the
  // latest message or the read position, unless the link fails first.
  const [startAtLink, setStartAtLink] = useState(
    () => selectedEventSeq !== undefined || linkedTurnId !== undefined,
  );
  const detail = props.detail;
  // Jump to latest, a send, or the mobile keyboard skips the newer pages for
  // the rest of the visit. It can come before the unread page loads.
  const [showLatest, setShowLatest] = useState(false);
  // A link at open wins over the read position. When the loaded rows hold
  // the link, the transcript keeps them and does not page to the read
  // position.
  const opensAtUnread = startAtUnread && !showLatest && !startAtLink;
  // A linked row that the transcript does not hold. The transcript opens at
  // the page around it until the reader jumps to the latest. A link at open
  // starts there, so the first render reads no other page.
  const [linkStart, setLinkStart] = useState(() =>
    linkedTurnId !== undefined
      ? unheldLinkStart(detail.data?.events, { turn: linkedTurnId })
      : selectedEventSeq === undefined
        ? undefined
        : unheldLinkStart(detail.data?.events, { event: selectedEventSeq }),
  );
  const showLatestPage = useCallback(() => {
    setShowLatest(true);
    setLinkStart(undefined);
  }, []);
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
  const [confirmChildArchive, setConfirmChildArchive] = useState(false);
  const navigate = useNavigate();
  const setArchived = (archived: boolean) => {
    archive.mutate({
      archived,
      lastSeenAt: conversation!.lastSeenAt,
    });
    // Archiving hides this conversation, so go home at once. The mutation
    // keeps running after this page unmounts.
    if (archived) {
      navigate("/", {
        state: {
          archivedConversation: conversation!,
        } satisfies ArchivedFromConversationState,
      });
    }
  };
  const pin = usePinConversation(conversationId);
  const markUnread = useMarkConversationUnread(conversationId);
  const markRead = useMarkConversationRead(conversationId);
  // Focus or a click in the composer counts as reading, like transcript input.
  const [composerEngaged, setComposerEngaged] = useState(false);
  const engageComposer = useCallback(() => setComposerEngaged(true), []);
  const readAtOpen = useReadPositionAtOpen(detail.data, detail.fetchedDetail);
  const dropLink = useCallback(() => {
    setLinkStart(undefined);
    setStartAtLink(false);
    setMemoryJump(undefined);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(CONVERSATION_EVENT_PARAM);
        next.delete(CONVERSATION_TURN_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  const unreadCursor = opensAtUnread ? readAtOpen.unreadCursor : undefined;
  const aroundHistory = useHistoryAround({
    conversationId,
    // Cached earlier pages from a past visit would look like newer events.
    detail: detail.latest,
    onShowLatest: showLatestPage,
    // A link that fails to load is dropped. The transcript goes back to
    // where it was.
    ...(linkStart
      ? { onStartFailed: dropLink, start: linkStart }
      : unreadCursor
        ? {
            start: { around: unreadCursor },
            ...(readAtOpen.unreadPage
              ? { startPage: readAtOpen.unreadPage }
              : undefined),
          }
        : undefined),
  });
  // The transcript on screen, so it can stay while the next one loads. The
  // page is keyed by Conversation, so at open this is the cached copy.
  const shownRef = useRef(detail.data);
  // A reader far behind sees the events from their read position, and a
  // link shows the events around its row. Others see the latest page and
  // the pages before it. The transcript on screen stays until this visit's
  // fetch tells where to open and the page around that row loads. It loads
  // no earlier pages and shows no marker: at open, both would come from the
  // cached read position. It reports no reads, because it can sit at rows
  // the reader has not read yet. Then the transcript opens at the row, if
  // the reader has not moved.
  const holdShown = Boolean(
    shownRef.current &&
    (aroundHistory?.isPending ||
      (opensAtUnread && !linkStart && !detail.fetchedAtOpen)),
  );
  const transcriptPending =
    detail.isPending || Boolean(aroundHistory?.isPending && !shownRef.current);
  const history: TranscriptHistory = holdShown
    ? {
        ...detail,
        data: shownRef.current,
        hasPreviousPage: false,
        isLoadingPreviousPage: false,
        loadPreviousPage: () => {},
      }
    : (aroundHistory ?? detail);
  if (history.data) shownRef.current = history.data;
  const catchUp = useConversationCatchUp({
    conversationId,
    events: history.data?.events,
    hasNewerPage: Boolean(history.newer),
    hasPreviousPage: history.hasPreviousPage,
    unread: holdShown ? undefined : readAtOpen.unread,
  });
  const feedConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const conversation = applyPendingArchiveUpdate(
    conversationFromDetail(detail.data) ?? feedConversation,
    props.pendingArchiveUpdate,
  );
  const unread = Boolean(conversation?.unread);
  const conversationDetail = detail.data;
  const links = conversationLinks(conversationDetail);
  const title =
    conversationDetailTitle(detail.data) ??
    conversationDisplayTitle(conversation);
  useDocumentTitle(detail.data || conversation ? title : undefined);
  // A Task takes input only from its parent agent, and it runs without
  // interactive auth, so it has no approval to show.
  const canReply =
    view === "rich" &&
    detail.data?.isParticipant &&
    detail.data.kind !== "task";
  // A navigation can ask for the reply box. Ask the footer once for it, so
  // coming back from the event log does not focus it again.
  const location = useLocation();
  const [replyFocusDoneKey, setReplyFocusDoneKey] = useState<string>();
  const replyFocusRequest =
    requestsReplyFocus(location.state) && location.key !== replyFocusDoneKey
      ? location.key
      : undefined;
  const transcript = history.data;
  const transcriptShown = !transcriptPending && Boolean(transcript);
  useEffect(() => {
    if (transcriptShown) recordTranscriptShown();
  }, [conversationId, transcriptShown]);
  const outlineEvents =
    transcript?.eventHistory.status === "available"
      ? transcript.events
      : undefined;
  const selectOutlineItem = useCallback((seq: number) => {
    // Search can hide the row.
    setSearch("");
    setRevealSeq(seq);
  }, []);
  const selectedEvent =
    transcript?.eventHistory.status === "expired"
      ? undefined
      : transcript?.events.find((event) => event.seq === selectedEventSeq);
  const visualStatus = conversation
    ? visualStatusForConversation(conversation)
    : undefined;
  // History and mailbox use the same deferred server snapshot.
  const live = conversationIsLive(visualStatus, detail.data);
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
  // The event log sits inside its Conversation, so mobile back leaves it.
  useRegisterMobileHeaderBack(
    view === "raw" ? "Back to conversation" : undefined,
    () => onViewChange("rich"),
  );
  // A linked event, Turn, or memory can be outside the loaded rows. Then the
  // transcript opens at the page around it, which the server finds by the
  // event seq or Turn id. Only a new link does this, so a reader who jumps to
  // the latest stays there. Returns false when the loaded rows hold the link.
  const openLink = useEffectEvent((link: ConversationLink) => {
    const start = unheldLinkStart(history.data?.events, link);
    if (start) setLinkStart(start);
    return Boolean(start);
  });
  useEffect(() => {
    if (linkedTurnId !== undefined) openLink({ turn: linkedTurnId });
    else if (selectedEventSeq !== undefined) {
      openLink({ event: selectedEventSeq });
    }
  }, [linkedTurnId, selectedEventSeq]);
  // Replace a found Turn link with a link to its first event.
  const linkedTurnSeq = linkedTurnId
    ? turnStartedEventSeq(transcript?.events, linkedTurnId)
    : undefined;
  useEffect(() => {
    if (linkedTurnSeq !== undefined) setSelectedEventSeq(linkedTurnSeq);
  }, [linkedTurnSeq, setSelectedEventSeq]);
  // Show a chosen memory at its transcript row, once the row renders.
  useEffect(() => {
    if (!memoryJump || !transcript) return;
    const anchor = pageRef.current?.querySelector(
      `[data-memory-anchor="${CSS.escape(memoryAnchorKey(memoryJump))}"]`,
    );
    if (anchor) {
      anchor.scrollIntoView({ block: "center" });
      setMemoryPopover(memoryJump);
      setMemoryJump(undefined);
    } else if (!holdShown && !openLink({ event: memoryJump.seq })) {
      // The loaded rows hold the event, but no row shows the memory.
      setMemoryJump(undefined);
    }
  }, [holdShown, memoryJump, transcript, view]);
  // Keep the panel while the transcript or a linked event loads, and for the
  // render before a found Turn link becomes an event link.
  const eventLoading =
    eventOpen &&
    !selectedEvent &&
    (transcriptPending || holdShown || linkedTurnId !== undefined);
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
    showLatestPage();
    setPinRequestVersion((version) => version + 1);
  }, [showLatestPage]);
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

  const sidePanel = (
    <>
      {showDetails ? (
        <ConversationDetailsPanel
          conversation={conversation}
          conversationId={conversationId}
          detail={conversationDetail}
          feedConversations={conversations}
          highlightReview={reviewOpen}
          links={links}
          memoryState={memoryState}
          onClose={closeDetails}
          onOpenSubagent={setSubagentTarget}
          onSelectMemory={(entry) => {
            // Memory rows show only in the Conversation view, and search
            // can hide them.
            if (view !== "rich") onViewChange("rich");
            setSearch("");
            setRevealSeq(entry.seq);
            setMemoryJump({
              memoryId: entry.memory.id,
              seq: entry.seq,
              source: entry.source,
              turnId: entry.turnId,
            });
          }}
        />
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
    </>
  );

  // Pin the transcript to one row. The mobile sheet slot is a grid item too, and
  // an implicit row for it took height from short transcripts.
  return (
    <div
      ref={pageRef}
      className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]"
    >
      <ConversationSidePanelLayout
        side={
          showDetails || showEvent || turnContext || showQuickQuestion
            ? sidePanel
            : undefined
        }
      >
        <ChatLayout
          header={
            <ConversationHeader
              agentTree={
                isChildConversation(conversationDetail) ? (
                  <ConversationAgentTree nodes={conversationDetail.agentTree} />
                ) : null
              }
              contextTags={conversationContextTags(conversation)}
              conversationId={conversationId}
              continueInSlack={
                detail.data?.canContinueInSlack
                  ? {
                      // The API refuses while a Turn runs.
                      disabled: live,
                      onClick: () => setContinueInSlackOpen(true),
                    }
                  : undefined
              }
              cost={conversationCost(conversation, conversationDetail, "below")}
              detailsOpen={showDetails}
              onDetailsClick={() => {
                if (eventOpen) setSelectedEventSeq(undefined);
                setTurnContext(undefined);
                quickQuestion.close();
                if (showDetails) {
                  closeDetails();
                } else {
                  focusDetailsOnOpen.current = true;
                  setDetailsChoice(true);
                }
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
                links.length ? <ConversationAnnotations links={links} /> : null
              }
              pin={{
                // The API lets only participants pin a root, the same as
                // archive. A child page has an agent tree.
                disabled:
                  !conversation ||
                  !detail.data?.isParticipant ||
                  isChildConversation(conversationDetail) ||
                  pin.isPending,
                error: Boolean(pin.error),
                onClick: () => pin.mutate(!conversation?.pinnedAt),
                pinned: Boolean(conversation?.pinnedAt),
              }}
              read={{
                // Unread tracks idle conversations only, like the sidebar row.
                disabled:
                  !conversation ||
                  !detail.data?.isParticipant ||
                  markUnread.isPending ||
                  (!unread && !isIdleConversation(conversation)),
                error: Boolean(markUnread.error),
                onClick: () => markUnread.mutate(!unread),
                unread,
              }}
              archive={{
                archived: Boolean(conversation?.archivedAt),
                disabled: !conversation || archive.isPending,
                // A refused restore names the archived ancestor to restore
                // first.
                error: archive.error
                  ? (archive.error instanceof DashboardApiError &&
                      archive.error.apiError) ||
                    "Could not update archive state."
                  : undefined,
                onClick: () => {
                  if (conversation?.archivedAt) {
                    setArchived(false);
                  } else if (conversation!.kind === "root") {
                    setArchived(true);
                  } else {
                    setConfirmChildArchive(true);
                  }
                },
                pending: archive.isPending,
              }}
              onSearchChange={setSearch}
              onViewChange={onViewChange}
              privacy={
                <ConversationPrivacyChip
                  visibility={conversation?.visibility}
                />
              }
              search={search}
              searchMatch={searchMatch}
              sentryConversationUrl={detail.data?.sentryConversationUrl}
              sidebarToggle={props.sidebarToggle}
              title={title}
              view={view}
            />
          }
          overlay={
            view === "rich" && !transcriptPending && outlineEvents ? (
              <ConversationOutline
                events={outlineEvents}
                onSelect={selectOutlineItem}
                scrollRef={scrollRef}
              />
            ) : undefined
          }
          scrollMinTall
          scrollAriaLabel="Conversation transcript"
          scrollRef={scrollRef}
          scrollClassName={cn(
            "thin-scrollbar",
            view !== "raw" && "px-4 pb-4 md:px-7 md:pb-6",
          )}
          scroll={
            <section className="min-w-0">
              <div
                className={
                  view === "raw"
                    ? "w-full"
                    : "mx-auto w-full max-w-[52.5rem] pt-5 md:pt-7"
                }
              >
                {transcriptPending ? (
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
                      <ConversationCatchUpContext value={catchUp}>
                        <Transcript
                          hasPreviousPage={history.hasPreviousPage}
                          historyError={history.historyError}
                          historyVersion={history.historyVersion}
                          lastReadSeq={detail.data?.readPosition?.lastReadSeq}
                          live={live}
                          loadingPreviousPage={history.isLoadingPreviousPage}
                          newerHistory={history.newer}
                          onLoadPreviousPage={history.loadPreviousPage}
                          onRead={holdShown ? undefined : markRead}
                          readEngaged={composerEngaged}
                          onSelectedEventSeqChange={setSelectedEventSeq}
                          // Sends and the thinking row belong after the latest event.
                          pendingMessages={
                            history.newer ? undefined : detail.inlineMessages
                          }
                          pinRequestVersion={pinRequestVersion}
                          revealSeq={revealSeq}
                          responding={
                            !detail.error &&
                            !history.newer &&
                            conversationIsResponding(detail.data)
                          }
                          onOpenSubagentTranscript={onOpenSubagentTranscript}
                          search={search}
                          onSearchChange={setSearch}
                          searchMatch={searchMatch.index}
                          onSearchMatches={searchMatch.setMatches}
                          selectedEventSeq={selectedEventSeq}
                          startAtLink={startAtLink}
                          startAtUnread={startAtUnread}
                          transcript={transcript}
                          turnContextPanel={turnContextPanel}
                          unread={holdShown ? undefined : readAtOpen.unread}
                          view={view}
                        />
                      </ConversationCatchUpContext>
                    </ConversationMemoryContext>
                  </>
                )}
              </div>
            </section>
          }
          dock={
            canReply ? (
              <div
                className="contents"
                onFocusCapture={engageComposer}
                onPointerDownCapture={engageComposer}
              >
                <ConversationPageDock
                  conversationId={conversationId}
                  detail={detail}
                  focusRequest={replyFocusRequest}
                  hasNewerPage={Boolean(history.newer)}
                  live={live}
                  onFocusRequestDone={setReplyFocusDoneKey}
                  onPinRequest={requestPin}
                  ref={replyRef}
                />
              </div>
            ) : undefined
          }
        />
      </ConversationSidePanelLayout>
      {confirmChildArchive ? (
        <ArchiveChildDialog
          hasChildren={Boolean(detail.data?.childAgentTotals?.count)}
          onClose={() => setConfirmChildArchive(false)}
          onConfirm={() => {
            setConfirmChildArchive(false);
            setArchived(true);
          }}
        />
      ) : null}
      <QuickQuestionSelectionButton
        onAsk={(selection) => {
          if (eventOpen) setSelectedEventSeq(undefined);
          setTurnContext(undefined);
          quickQuestion.open(selection);
        }}
        onRespond={
          canReply ? (quote) => replyRef.current?.appendText(quote) : undefined
        }
        rootRef={pageRef}
      />
      <SubagentTranscriptDrawer
        onClose={() => setSubagentTarget(undefined)}
        target={subagentTarget}
      />
      {continueInSlackOpen ? (
        <ContinueInSlackDialog
          conversationId={conversationId}
          onClose={() => setContinueInSlackOpen(false)}
        />
      ) : null}
    </div>
  );
}

function conversationIsLive(
  visualStatus: ReturnType<typeof visualStatusForConversation> | undefined,
  detail: ConversationDetailReport | undefined,
): boolean {
  if (detail) return detail.status === "active";
  return visualStatus === "active";
}
