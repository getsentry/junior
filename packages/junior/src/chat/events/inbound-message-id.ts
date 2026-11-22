// A leaf module, so the Turn lifecycle can tell Watch Event deliveries apart
// without loading the notification pipeline.
const EVENT_INBOUND_MESSAGE_PREFIX = "event:";

/** Build the mailbox message id that delivers one Watch Event. */
export function eventInboundMessageId(
  subscriptionId: string,
  eventKey: string,
): string {
  return `${EVENT_INBOUND_MESSAGE_PREFIX}${subscriptionId}:${eventKey}`;
}

/** Whether a mailbox message id is the delivery of a Watch Event. */
export function isEventInboundMessageId(id: string): boolean {
  return id.startsWith(EVENT_INBOUND_MESSAGE_PREFIX);
}
