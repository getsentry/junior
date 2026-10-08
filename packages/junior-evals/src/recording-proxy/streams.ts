/**
 * Recorded event streams (`text/event-stream`).
 *
 * A model stream sends a tool call or a text in many small deltas, so an id
 * that the model repeats can be split over two events. Before the proxy
 * writes changing values as placeholders (`values.ts`), it merges the
 * deltas of each Anthropic Messages content block into one event. A client
 * joins the deltas anyway, so it gets the same content.
 *
 * Thinking blocks keep their recorded text. A signature covers that text,
 * and the provider refuses a changed thinking block in a later request.
 *
 * Like the server, this file uses only Node built-ins.
 */

/** The text field of each delta type that the proxy merges. */
const DELTA_FIELDS: Record<string, string> = {
  input_json_delta: "partial_json",
  text_delta: "text",
  thinking_delta: "thinking",
};
const THINKING_TYPES = new Set([
  "redacted_thinking",
  "signature_delta",
  "thinking",
  "thinking_delta",
]);

interface StreamEvent {
  text: string;
  data?: Record<string, unknown>;
}

/** Whether a content type is an event stream. */
export const isEventStream = (contentType: string | undefined) =>
  /^text\/event-stream\b/i.test(contentType ?? "");

function parseEvent(text: string): StreamEvent {
  const line = text.split("\n").find((entry) => entry.startsWith("data:"));
  if (!line) return { text };
  try {
    const data: unknown = JSON.parse(line.slice(5).trim());
    return data && typeof data === "object" && !Array.isArray(data)
      ? { text, data: data as Record<string, unknown> }
      : { text };
  } catch {
    return { text };
  }
}

/** The type and text field of a delta event that the proxy can merge. */
function mergeableDelta(event: StreamEvent) {
  if (event.data?.type !== "content_block_delta") return undefined;
  const delta = event.data.delta as Record<string, unknown> | undefined;
  const field = DELTA_FIELDS[String(delta?.type)];
  if (!delta || !field || typeof delta[field] !== "string") return undefined;
  return { delta, field, index: event.data.index };
}

function splitEvents(body: string): StreamEvent[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .filter((text) => text.trim() !== "")
    .map(parseEvent);
}

const joinEvents = (events: StreamEvent[]) =>
  events.map((event) => `${event.text}\n\n`).join("");

/** Merge the deltas of each content block into one event. */
export function mergeStreamDeltas(body: string): string {
  const events: StreamEvent[] = [];
  for (const event of splitEvents(body)) {
    const current = mergeableDelta(event);
    const previousEvent = events.at(-1);
    const previous = previousEvent && mergeableDelta(previousEvent);
    if (
      current &&
      previous &&
      previous.index === current.index &&
      previous.delta.type === current.delta.type
    ) {
      previous.delta[previous.field] =
        `${previous.delta[previous.field] as string}${current.delta[current.field] as string}`;
      previousEvent.text = `event: content_block_delta\ndata: ${JSON.stringify(previousEvent.data)}`;
      continue;
    }
    events.push(event);
  }
  return joinEvents(events);
}

function isThinking(event: StreamEvent): boolean {
  const delta = event.data?.delta as { type?: unknown } | undefined;
  const block = event.data?.content_block as { type?: unknown } | undefined;
  return (
    THINKING_TYPES.has(String(delta?.type)) ||
    THINKING_TYPES.has(String(block?.type))
  );
}

/** Change each event of a stream, but keep thinking events as they are. */
export function mapStreamEvents(
  body: string,
  change: (text: string) => string,
): string {
  return joinEvents(
    splitEvents(body).map((event) =>
      isThinking(event) ? event : { text: change(event.text) },
    ),
  );
}
