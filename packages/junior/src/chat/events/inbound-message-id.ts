// A leaf module, so the Turn lifecycle can read legacy Turn starts without
// loading the notification pipeline.
const EVENT_INBOUND_MESSAGE_PREFIX = "event:";

/** Build the mailbox message id that delivers one Watch Event. */
export function eventInboundMessageId(
  subscriptionId: string,
  eventKey: string,
): string {
  return `${EVENT_INBOUND_MESSAGE_PREFIX}${subscriptionId}:${eventKey}`;
}

/**
 * Whether only Watch Event deliveries started a Turn whose `turn_started`
 * event predates its `watchEventsOnly` field, read from the input ids.
 *
 * TODO(dcramer): Delete once no Turn that started before `watchEventsOnly`
 * is open. A newer start without the field never has only these ids.
 */
export function legacyStartedByWatchEventsOnly(
  inputMessageIds: readonly string[],
): boolean {
  return (
    inputMessageIds.length > 0 &&
    inputMessageIds.every((id) => id.startsWith(EVENT_INBOUND_MESSAGE_PREFIX))
  );
}
