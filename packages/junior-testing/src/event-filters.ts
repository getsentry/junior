/** The parts of a plugin resource type that its filter declarations use. */
interface FilterResourceType {
  type: string;
  supportedEvents: readonly string[];
  matchFields?: Record<string, { events?: readonly string[] }>;
}

/** The parts of a published event that filters read. */
interface FilterEvent {
  eventType: string;
  data?: Record<string, unknown>;
}

/**
 * Compare each filter's `events` list with the data that real webhook events
 * set. A filter with no `events` list applies to every supported event. The
 * check goes both ways: a listed event must set the key, and an event that
 * sets the key must be listed. Every supported event needs at least one
 * published event, so give the fullest delivery of each webhook.
 *
 * Returns one plain sentence per mismatch, so a test can expect `[]`.
 */
export function filterEventMismatches(args: {
  resourceTypes: readonly FilterResourceType[];
  events: readonly FilterEvent[];
}): string[] {
  const keysByEvent = new Map<string, Set<string>>();
  for (const event of args.events) {
    const keys = keysByEvent.get(event.eventType) ?? new Set<string>();
    for (const key of Object.keys(event.data ?? {})) keys.add(key);
    keysByEvent.set(event.eventType, keys);
  }

  const mismatches: string[] = [];
  for (const resourceType of args.resourceTypes) {
    for (const eventType of resourceType.supportedEvents) {
      const keys = keysByEvent.get(eventType);
      if (!keys) {
        mismatches.push(`no fixture publishes ${eventType}`);
        continue;
      }
      for (const [key, field] of Object.entries(
        resourceType.matchFields ?? {},
      )) {
        const listed = field.events?.includes(eventType) ?? true;
        if (listed !== keys.has(key)) {
          mismatches.push(
            `${resourceType.type} filter ${key} ${listed ? "lists" : "omits"} ${eventType}, which ${keys.has(key) ? "sets" : "never sets"} it`,
          );
        }
      }
    }
  }
  return mismatches;
}
