import type { ConversationReportEvent } from "@sentry/junior/api/schema";

/**
 * Build the dashboard route for a conversation id. A `turnId` opens the
 * start of that Turn in the event log. `reviewItems` opens the Review items
 * panel.
 */
export function conversationPath(
  conversationId: string,
  options?: { reviewItems?: boolean; turnId?: string },
): string {
  const path = `/conversations/${encodeURIComponent(conversationId)}`;
  const params = new URLSearchParams();
  if (options?.turnId) params.set(CONVERSATION_TURN_PARAM, options.turnId);
  if (options?.reviewItems) {
    params.set(CONVERSATION_REVIEW_PARAM, CONVERSATION_REVIEW_OPEN);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Navigation state that asks the opened Conversation to focus its reply box.
 * `draftFrom` names the draft of a composer the reader typed in before the
 * page opened. The reply box takes its text.
 */
export type ReplyFocusState = { draftFrom?: string; focusReply: true };

/** Ask the opened Conversation to focus its reply box. */
export const FOCUS_REPLY_STATE = { focusReply: true } as const;

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
    draftFrom:
      "draftFrom" in state && typeof state.draftFrom === "string"
        ? state.draftFrom
        : undefined,
    focusReply: true,
  };
}

/** Dashboard home route. Legacy `/conversations/new` redirects here. */
export const NEW_CONVERSATION_PATH = "/";

/** True when the path shows the dashboard home page. */
export function isNewConversationPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/conversations/new";
}

/** Query param that opens one event log entry by its sequence number. */
export const CONVERSATION_EVENT_PARAM = "event";

/** Read a linked event sequence number. Ignore values that are not one. */
export function parseConversationEventSeq(
  value: string | null | undefined,
): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Query param that opens the Review items panel of a Conversation. */
export const CONVERSATION_REVIEW_PARAM = "review";
export const CONVERSATION_REVIEW_OPEN = "open";

/** Query param that opens the start of one Turn in the event log. */
export const CONVERSATION_TURN_PARAM = "turn";

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
