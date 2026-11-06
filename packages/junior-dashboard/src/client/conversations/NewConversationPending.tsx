import type { InputImage } from "@sentry/junior/api/schema";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ConversationTranscript } from "../types";
import { ChatLayout } from "./ChatLayout";
import { ComposerDock } from "./ComposerDock";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationPrivacyChip } from "./ConversationMeta";
import { ConversationSidePanelLayout } from "./ConversationSidePanelLayout";
import { useDetailsDefaultOpen } from "./conversationSidebarLayout";
import { DetailsPanel } from "../components/DetailsPanel";
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
  images?: InputImage[];
  message: string;
  visibility: "private" | "public";
};

const noop = () => {};

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
  // The server's title until title generation runs: the first line.
  const title =
    pending.message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "New conversation";
  const transcript = useMemo(
    (): ConversationTranscript => ({
      conversationId: pending.idempotencyKey,
      cumulativeDurationMs: 0,
      displayTitle: title,
      eventHistory: { status: "available" },
      events: [],
      generatedAt: pending.createdAt,
      isParticipant: true,
      lastProgressAt: pending.createdAt,
      lastSeenAt: pending.createdAt,
      startedAt: pending.createdAt,
      status: "active",
      surface: "internal",
      visibility: pending.visibility,
    }),
    [pending, title],
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

  return (
    <section
      aria-busy="true"
      aria-label="Selected conversation"
      className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
    >
      <div className="grid h-full min-h-0 min-w-0">
        <ConversationSidePanelLayout
          side={
            showDetails ? (
              <div className="contents" inert>
                <DetailsPanel
                  label="Conversation details"
                  onClose={noop}
                  title={
                    <h2 className="m-0 flex min-w-0 items-center gap-1.5 font-sans text-sm">
                      <span className="font-semibold text-dashboard-text">
                        Details
                      </span>
                    </h2>
                  }
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
                archive={{
                  archived: false,
                  disabled: true,
                  error: false,
                  onClick: noop,
                  pending: false,
                }}
                conversationId={pending.idempotencyKey}
                detailsOpen={showDetails}
                live
                pending
                onDetailsClick={noop}
                onSearchChange={noop}
                onViewChange={noop}
                pin={{
                  disabled: true,
                  error: false,
                  onClick: noop,
                  pinned: false,
                }}
                privacy={
                  <ConversationPrivacyChip visibility={pending.visibility} />
                }
                search=""
                sidebarToggle={props.sidebarToggle}
                title={title}
                view="rich"
              />
            }
            scrollMinTall
            scrollAriaLabel="Conversation transcript"
            scrollClassName="thin-scrollbar px-4 pb-4 md:px-7 md:pb-6"
            scroll={
              <section className="min-w-0">
                {/* The message lands with a short fade. The page that replaces
                this view has the same rows, so the swap does not show. */}
                <div className="mx-auto w-full max-w-[52.5rem] pt-5 duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 md:pt-7">
                  <Transcript
                    pendingMessages={messages}
                    responding
                    transcript={transcript}
                  />
                </div>
              </section>
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
    </section>
  );
}
