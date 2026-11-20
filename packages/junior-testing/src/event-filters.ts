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

/** A published event and the identifier it went to. */
interface IdentifiedEvent extends FilterEvent {
  eventKey: string;
  identifier: string;
}

/**
 * Check that a saved identifier can become filters that select the same
 * events. `toMatch` turns one identifier into a match, the way a saved
 * trigger is converted. It gets the event type too, because a trigger keeps
 * its events and one identifier, such as `owner/repo#12`, can name an issue
 * or a pull request. For each published event, the match of its
 * identifier must use only filters that the plugin declares for that event
 * type, and it must match the event. It must not match an event of the same
 * type that did not go to that identifier, so a conversion never widens a
 * trigger. Each event needs at least one such other event, so give fixtures
 * that differ in each part of the identifier.
 *
 * Copies of one event have the same `eventKey`, so give each fixture
 * delivery its own key. Pass `eventMatches` from plugin-api as `matches`, so
 * the check uses the real match rule. Returns one plain sentence per
 * mismatch, so a test can expect `[]`.
 */
export function identifierMatchMismatches<Match extends object>(args: {
  resourceTypes: readonly FilterResourceType[];
  events: readonly IdentifiedEvent[];
  matches: (match: Match, data: Record<string, unknown> | undefined) => boolean;
  toMatch: (event: {
    eventType: string;
    identifier: string;
  }) => Match | undefined;
}): string[] {
  const mismatches = new Set<string>();
  const identifiersByKey = new Map<string, Set<string>>();
  for (const event of args.events) {
    const identifiers = identifiersByKey.get(event.eventKey) ?? new Set();
    identifiers.add(event.identifier);
    identifiersByKey.set(event.eventKey, identifiers);
  }
  for (const event of args.events) {
    const name = `${event.identifier} on ${event.eventType}`;
    const match = args.toMatch(event);
    if (!match) {
      mismatches.add(`${event.identifier} has no match`);
      continue;
    }
    for (const key of Object.keys(match)) {
      if (declaresFilter(args.resourceTypes, event.eventType, key)) continue;
      mismatches.add(`${name} uses ${key}, which is not a filter`);
    }
    if (!args.matches(match, event.data)) {
      mismatches.add(`${name} does not match its own event`);
    }
    const others = args.events.filter(
      (other) =>
        other.eventType === event.eventType &&
        !identifiersByKey.get(other.eventKey)?.has(event.identifier),
    );
    if (others.length === 0) {
      mismatches.add(`${name} has no event on a different identifier`);
    }
    for (const other of others) {
      if (!args.matches(match, other.data)) continue;
      mismatches.add(`${name} also matches ${other.eventKey}`);
    }
  }
  return [...mismatches];
}

/** Whether a resource type that supports the event declares this filter for it. */
function declaresFilter(
  resourceTypes: readonly FilterResourceType[],
  eventType: string,
  key: string,
): boolean {
  return resourceTypes.some((resourceType) => {
    const field = resourceType.matchFields?.[key];
    return (
      field !== undefined &&
      resourceType.supportedEvents.includes(eventType) &&
      (field.events?.includes(eventType) ?? true)
    );
  });
}
