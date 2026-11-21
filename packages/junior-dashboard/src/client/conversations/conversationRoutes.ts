import type { ConversationReportEvent } from "@sentry/junior/api/schema";

/**
 * Build the dashboard route for a conversation id. An `askItemId` shows the
 * transcript record of that Inbox item. A `turnId` opens the start of that
 * Turn in the event log. A `messageId` shows that Message in the transcript.
 * `inboxItems` opens the Inbox items panel.
 */
export function conversationPath(
  conversationId: string,
  options?: {
    askItemId?: string | undefined;
    messageId?: string | undefined;
    inboxItems?: boolean;
    turnId?: string | undefined;
  },
): string {
  const path = `/conversations/${encodeURIComponent(conversationId)}`;
  const params = new URLSearchParams();
  if (options?.askItemId) {
    params.set(CONVERSATION_ASK_PARAM, options.askItemId);
  }
  if (options?.turnId) params.set(CONVERSATION_TURN_PARAM, options.turnId);
  if (options?.messageId) {
    params.set(CONVERSATION_MESSAGE_PARAM, options.messageId);
  }
  if (options?.inboxItems) {
    params.set(CONVERSATION_REVIEW_PARAM, CONVERSATION_REVIEW_OPEN);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The same-origin link of a Conversation, as message text holds it. */
export function conversationUrl(conversationId: string): string {
  return `${window.location.origin}${conversationPath(conversationId)}`;
}

/**
 * Navigation state that asks the opened Conversation to focus its reply box.
 * `draftFrom` names the draft of a composer the reader typed in before the
 * page opened. The reply box takes its text. `questionId` names the docked
 * question to show and focus.
 */
export type ReplyFocusState = {
  /** The reader asked to type, so the reply box takes focus on touch too. */
  compose?: true | undefined;
  draftFrom?: string | undefined;
  focusReply: true;
  questionId?: string | undefined;
};

/** Ask the opened Conversation to focus its reply box. */
export const FOCUS_REPLY_STATE = { focusReply: true } as const;

/** Ask the opened Conversation for its reply box, to type a new request. */
export const COMPOSE_REPLY_STATE = { compose: true, focusReply: true } as const;

/** Read the reply focus that navigation state asks for, if any. */
export function readReplyFocus(state: unknown): ReplyFocusState | undefined {
  if (
    typeof state !== "object" ||
    state === null ||
    !("focusReply" in state) ||
    state.focusReply !== true
  ) {
    return undefined;
  }
  return {
    compose: "compose" in state && state.compose === true ? true : undefined,
    draftFrom:
      "draftFrom" in state && typeof state.draftFrom === "string"
        ? state.draftFrom
        : undefined,
    focusReply: true,
    questionId:
      "questionId" in state && typeof state.questionId === "string"
        ? state.questionId
        : undefined,
  };
}

/** Navigation state that opens the Conversation at its event log. */
export const OPEN_EVENT_LOG_STATE = { eventLog: true } as const;

/** True when navigation state asks for the event log. */
export function readOpenEventLog(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "eventLog" in state &&
    state.eventLog === true
  );
}

/** Match the router path of one Conversation page, with no query. */
export const CONVERSATION_PATH = /^\/conversations\/[^/]+$/;

/** Dashboard home route. Legacy `/conversations/new` redirects here. */
export const NEW_CONVERSATION_PATH = "/";

/**
 * The new UI's composer for a new Conversation, which "+" opens. Its home
 * is the Inbox.
 */
export const COMPOSER_PATH = "/conversations/new";

/** True when the path shows the dashboard home page or the composer. */
export function isNewConversationPath(pathname: string): boolean {
  return pathname === "/" || pathname === COMPOSER_PATH;
}

/** Query param that opens one event log entry by its sequence number. */
export const CONVERSATION_EVENT_PARAM = "event";

/** Read a linked event sequence number. Ignore values that are not one. */
export function parseConversationEventSeq(
  value: string | null | undefined,
): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Query param that opens the Inbox items panel of a Conversation. */
export const CONVERSATION_REVIEW_PARAM = "review";
export const CONVERSATION_REVIEW_OPEN = "open";

/** Query param that opens the start of one Turn in the event log. */
export const CONVERSATION_TURN_PARAM = "turn";

/** Query param that shows one Message in the transcript by its id. */
export const CONVERSATION_MESSAGE_PARAM = "message";

/** Query param that shows the transcript record of one Inbox item. */
export const CONVERSATION_ASK_PARAM = "ask";

/** Find the sequence number of the event that stored a Message. */
export function messageEventSeq(
  events: readonly ConversationReportEvent[] | undefined,
  messageId: string,
): number | undefined {
  return events?.find(
    ({ data }) => data.type === "message" && data.messageId === messageId,
  )?.seq;
}

/** Find the sequence number of the event that started a Turn. */
export function turnStartedEventSeq(
  events: readonly ConversationReportEvent[] | undefined,
  turnId: string,
): number | undefined {
  return events?.find(
    ({ data }) =>
      data.type === "turn_lifecycle" &&
      data.state === "started" &&
      data.turnId === turnId,
  )?.seq;
}
