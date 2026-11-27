import { useQuery } from "@tanstack/react-query";
import { use, useMemo } from "react";
import {
  conversationQuestionsReportSchema,
  inboxItemQuestion,
  type ConversationQuestion,
  type ConversationReportEvent,
  type InboxItemPayload,
} from "@sentry/junior/api/schema";

import { TranscriptEvents } from "../inbox/InboxItemTurnMessage";
import {
  inboxItemAskFromToolCall,
  type InboxItemAsk,
} from "../inbox/inboxItemFormat";
import { revalidatedJsonQuery } from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import { conversationDetailQueryOptions } from "./queries";

/**
 * Read the questions that agents asked in one Conversation, with their
 * answers. It is a side read of the transcript, so a detail change
 * refreshes it.
 */
export function useConversationQuestions(
  conversationId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryFn: revalidatedJsonQuery(
      conversationQuestionsReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/questions`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "questions"),
    retry: false,
  });
}

/**
 * Read one question of a Conversation. `unavailable` is true when the
 * viewer cannot read the questions, or the Conversation has no such
 * question.
 */
export function useConversationQuestion(
  conversationId: string,
  questionId: string | undefined,
): { question?: ConversationQuestion; unavailable: boolean } {
  const { data, isError } = useConversationQuestions(conversationId, {
    enabled: questionId !== undefined,
  });
  const question = data?.questions.find((entry) => entry.id === questionId);
  return {
    question,
    unavailable:
      questionId === undefined || isError || (data !== undefined && !question),
  };
}

/** The asks that the loaded tool calls of a transcript added, in order. */
export function transcriptAsks(
  events: readonly ConversationReportEvent[] | undefined,
): InboxItemAsk[] {
  return (events ?? []).flatMap((event) =>
    event.data.type === "tool_calls"
      ? event.data.calls.flatMap((call) => {
          const ask = inboxItemAskFromToolCall(call);
          return ask ? [ask] : [];
        })
      : [],
  );
}

/**
 * Return the question of the Inbox item that a loaded tool call of the
 * Conversation added, or undefined when none is loaded. In the transcript
 * it reads the loaded events; elsewhere, such as the queue above the
 * composer, the cached detail.
 */
export function useAskedQuestionId(
  conversationId: string,
  itemId: string,
): string | undefined {
  const transcriptEvents = use(TranscriptEvents);
  const detailEvents = useQuery({
    ...conversationDetailQueryOptions(conversationId),
    enabled: false,
  }).data?.events;
  const events = transcriptEvents ?? detailEvents;
  return useMemo(
    () =>
      transcriptAsks(events).find((ask) => ask.itemId === itemId)?.questionId,
    [events, itemId],
  );
}

/**
 * True while a question waits for an answer: it has a form, no answer, and
 * has not closed. It waits on anyone who can see it.
 */
export function questionWaits(question: ConversationQuestion): boolean {
  return (
    !question.closedAt &&
    !question.answer &&
    Boolean(inboxItemQuestion(question.request))
  );
}

/**
 * Build the item of an open question, for the Inbox item actions. The
 * transcript reads no item, so the fields that only the item has, such as
 * assignees and visibility, hold placeholders. The actions route decides
 * whether the viewer may act.
 */
export function openQuestionItem(
  question: ConversationQuestion,
  ask: { conversationId: string; itemId: string },
): InboxItemPayload {
  return {
    assignedToEveryone: false,
    assignees: [],
    body: question.body,
    canAct: true,
    canAnswer: true,
    canTake: false,
    conversationIds: [ask.conversationId],
    createdAt: question.createdAt,
    id: ask.itemId,
    kind: "action",
    owner: { id: ask.conversationId, kind: "conversation" },
    // A snooze names this Conversation, and the server finds its root.
    rootConversationId: ask.conversationId,
    status: "open",
    subject: { id: question.id, kind: "question" },
    title: question.title,
    updatedAt: question.updatedAt,
    visibility: "private",
    ...(question.mentions ? { mentions: question.mentions } : undefined),
    ...(question.request ? { request: question.request } : undefined),
    ...(question.turnId ? { addedByTurnId: question.turnId } : undefined),
  };
}
