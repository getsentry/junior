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
 * History state key on a Conversation route. Its value is the draft id of a
 * composer that is gone. The page's reply box takes that draft and focus.
 */
export const COMPOSER_DRAFT_FROM_STATE = "composerDraftFrom";

/** Read the draft id that the page's reply box takes, if any. */
export function readComposerDraftFrom(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const value: unknown = (state as Record<string, unknown>)[
    COMPOSER_DRAFT_FROM_STATE
  ];
  return typeof value === "string" ? value : undefined;
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
