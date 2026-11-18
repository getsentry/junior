type TurnReport = { turnActive: boolean };

/**
 * Whether a Turn of the Conversation is queued or running. Live views poll,
 * show thinking, and offer Stop on it, not on `status`: an open action item
 * reads `needs_input` while a Turn runs. The detail is fresher than a feed
 * row, so it wins when both are loaded.
 */
export function conversationTurnIsActive(
  detail: TurnReport | null | undefined,
  conversation?: TurnReport | null,
): boolean {
  return (detail ?? conversation)?.turnActive ?? false;
}
