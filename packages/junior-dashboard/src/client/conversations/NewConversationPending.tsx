import type { InputImage } from "@sentry/junior/api/schema";
import { useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ConversationTranscript } from "../types";
import { ChatLayout } from "./ChatLayout";
import { ComposerDock } from "./ComposerDock";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationPrivacyChip } from "./ConversationMeta";
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

  return (
    <section
      aria-busy="true"
      aria-label="Selected conversation"
      className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
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
            detailsOpen={false}
            live
            onDetailsClick={noop}
            onSearchChange={noop}
            onViewChange={noop}
            pin={{ disabled: true, error: false, onClick: noop, pinned: false }}
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
          // Inert until the Conversation exists: a reply here would have no
          // Conversation to go to.
          <ComposerDock>
            <div inert>
              <ConversationComposer
                draftId={`pending:${pending.idempotencyKey}`}
                label="Continue this conversation"
                submitLabel="Send"
                onSubmit={async () => {}}
              />
            </div>
          </ComposerDock>
        }
      />
    </section>
  );
}
