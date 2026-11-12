import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ConversationTranscript } from "../types";
import {
  ChatLayout,
  TranscriptColumn,
  transcriptScrollClassName,
} from "./ChatLayout";
import { ComposerDock } from "./ComposerDock";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { useTranscriptSearchMatch } from "./transcriptSearch";
import { ConversationPrivacyChip } from "./ConversationMeta";
import { ConversationSidePanelLayout } from "./ConversationSidePanelLayout";
import { useDetailsDefaultOpen } from "./conversationSidebarLayout";
import { DetailsPanel } from "../components/DetailsPanel";
import { useRegisterMobileHeaderBack } from "../components/layout/DashboardChrome";
import {
  conversationOutboxMessageForSubmit,
  mailboxMessageFromOutbox,
  outboxActorIdentity,
} from "./conversationOutbox";
import { Transcript } from "./TranscriptView";

/** A first message sent from home whose create is not accepted yet. */
export type PendingNewConversation = {
  createdAt: string;
  idempotencyKey: string;
  files?: File[];
  message: string;
  visibility: "private" | "public";
};

const noop = () => {};

const detailsTitle = (
  <h2 className="m-0 flex min-w-0 items-center gap-1.5 font-sans text-sm">
    <span className="font-semibold text-dashboard-text">Details</span>
  </h2>
);

// The page shows the server's title when it opens.
const PENDING_TITLE = "New conversation";

// The header is inert until the Conversation exists.
const PENDING_MENU_ACTIONS = {
  archive: noop,
  continueInSlack: noop,
  delivery: noop,
  eventLog: noop,
  pin: noop,
  read: noop,
  rename: noop,
  subscription: noop,
};
const PENDING_MENU_STATE = {
  archive: false,
  delivery: false,
  pin: false,
  read: false,
  subscription: false,
};

/**
 * The draft of the reply box shown while a new Conversation is created. The
 * Conversation page takes it when it opens.
 */
export function newConversationDraftId(idempotencyKey: string): string {
  return `pending:${idempotencyKey}`;
}

/**
 * Show a new Conversation as soon as its first message is sent, laid out
 * like the Conversation page: the message, Junior at work, and the reply
 * dock. The page replaces it when the create is accepted.
 */
export function NewConversationPending(props: {
  pending: PendingNewConversation;
  sidebarToggle?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { pending } = props;
  const transcript = useMemo(
    (): ConversationTranscript => ({
      conversationId: pending.idempotencyKey,
      cumulativeDurationMs: 0,
      displayTitle: PENDING_TITLE,
      eventHistory: { status: "available" },
      events: [],
      generatedAt: pending.createdAt,
      isParticipant: true,
      kind: "root",
      lastProgressAt: pending.createdAt,
      lastSeenAt: pending.createdAt,
      startedAt: pending.createdAt,
      status: "active",
      surface: "internal",
      visibility: pending.visibility,
    }),
    [pending],
  );
  const messages = useMemo(
    () => [
      mailboxMessageFromOutbox({
        ...conversationOutboxMessageForSubmit({
          ...pending,
          actorIdentity: outboxActorIdentity(queryClient),
          inline: true,
          messageId: pending.idempotencyKey,
          now: pending.createdAt,
        }),
        status: "accepted",
      }),
    ],
    [pending, queryClient],
  );

  // The reader keeps typing in the reply box, as on the page.
  const composerRef = useRef<ConversationComposerHandle>(null);
  useEffect(() => composerRef.current?.focus(), []);
  // The page opens its details panel at this width. Open it here too, so
  // the transcript does not move when the page replaces this view. Its
  // content fills in on the page. The header actions and panel are inert
  // until then: they need a Conversation, and a details choice made here
  // would not carry over to the page.
  const showDetails = useDetailsDefaultOpen();
  const searchMatch = useTranscriptSearchMatch("");
  // Home has no Conversation chrome. Show the page's, so mobile does not
  // flash the home header before the route changes. Back waits, like the
  // header actions: home's composer holds the sent text until the create is
  // accepted.
  useRegisterMobileHeaderBack(
    "Back to conversations",
    undefined,
    PENDING_TITLE,
  );

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
      <ConversationSidePanelLayout
        side={
          showDetails ? (
            <div className="contents" inert>
              <DetailsPanel
                label="Conversation details"
                onClose={noop}
                title={detailsTitle}
              >
                {null}
              </DetailsPanel>
            </div>
          ) : undefined
        }
      >
        <ChatLayout
          header={
            <ConversationHeader
              detailsOpen={showDetails}
              errors={[]}
              menu={{
                actions: PENDING_MENU_ACTIONS,
                conversation: undefined,
                conversationId: pending.idempotencyKey,
                detail: undefined,
                pending: PENDING_MENU_STATE,
              }}
              pending
              onDetailsClick={noop}
              onSearchChange={noop}
              onViewChange={noop}
              privacy={
                <ConversationPrivacyChip visibility={pending.visibility} />
              }
              search=""
              searchMatch={searchMatch}
              sidebarToggle={props.sidebarToggle}
              title={PENDING_TITLE}
              view="rich"
            />
          }
          scrollMinTall
          scrollAriaLabel="Conversation transcript"
          scrollClassName={transcriptScrollClassName}
          scroll={
            // The message lands with a short fade. The page that replaces
            // this view has the same rows, so the swap does not show.
            <TranscriptColumn className="duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1">
              <Transcript
                pendingMessages={messages}
                responding
                transcript={transcript}
              />
            </TranscriptColumn>
          }
          dock={
            // Sends wait until the Conversation exists. Typed text moves to
            // the page's reply box.
            <ComposerDock>
              <ConversationComposer
                disabled
                draftId={newConversationDraftId(pending.idempotencyKey)}
                label="Continue this conversation"
                ref={composerRef}
                submitLabel="Send"
                onSubmit={async () => {}}
              />
            </ComposerDock>
          }
        />
      </ConversationSidePanelLayout>
    </div>
  );
}
