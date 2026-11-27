const EVENT_INBOUND_MESSAGE_PREFIX = "event:";

/** Build the mailbox message id that delivers one Watch Event. */
export function eventInboundMessageId(
  subscriptionId: string,
  eventKey: string,
): string {
  return `${EVENT_INBOUND_MESSAGE_PREFIX}${subscriptionId}:${eventKey}`;
}
