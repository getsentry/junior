/** The parts of a plugin resource type that its filter declarations use. */
interface FilterResourceType {
  type: string;
  supportedEvents: readonly string[];
  matchFields?: Record<string, FilterField>;
}

/** The parts of one filter declaration that its values must fit. */
interface FilterField {
  enum?: readonly string[];
  events?: readonly string[];
  kind: string;
  list?: true;
}

/** The parts of a published event that filters read. */
interface FilterEvent {
  eventType: string;
  data?: Record<string, unknown>;
}

/**
 * Compare each filter's `events` list with the data that real webhook events
 * set. A filter with no `events` list applies to every supported event. The
 * check goes both ways: some published event of a listed type must set the
 * key, and an event that sets the key must be listed. Some values are
 * optional, so one event of a listed type may leave a key out. Each value
 * that an event sets must have the field's kind, be one of its `enum` values,
 * and be a list only when the field is a list. Every supported event needs at
 * least one published event, so give the fullest delivery of each webhook.
 *
 * Returns one plain sentence per mismatch, so a test can expect `[]`.
 */
export function filterEventMismatches(args: {
  resourceTypes: readonly FilterResourceType[];
  events: readonly FilterEvent[];
}): string[] {
  const mismatches = new Set<string>();
  for (const resourceType of args.resourceTypes) {
    for (const eventType of resourceType.supportedEvents) {
      const published = args.events.filter(
        (event) => event.eventType === eventType,
      );
      if (published.length === 0) {
        mismatches.add(`no fixture publishes ${eventType}`);
        continue;
      }
      for (const [key, field] of Object.entries(
        resourceType.matchFields ?? {},
      )) {
        const name = `${resourceType.type} filter ${key}`;
        const listed = field.events?.includes(eventType) ?? true;
        const values = published
          .map((event) => event.data?.[key])
          .filter((value) => value !== undefined);
        if (listed && values.length === 0) {
          mismatches.add(`${name} lists ${eventType}, which never sets it`);
        }
        if (!listed && values.length > 0) {
          mismatches.add(`${name} omits ${eventType}, which sets it`);
        }
        for (const value of values) {
          if (fitsField(value, field)) continue;
          mismatches.add(
            `${name} on ${eventType} has ${JSON.stringify(value)}, which does not fit`,
          );
        }
      }
    }
  }
  return [...mismatches];
}

/** Whether one event value fits its filter's kind, enum, and list. */
function fitsField(value: unknown, field: FilterField): boolean {
  if (Array.isArray(value) !== Boolean(field.list)) return false;
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        typeof entry === field.kind &&
        (!field.enum || field.enum.includes(entry as string)),
    )
  );
}
