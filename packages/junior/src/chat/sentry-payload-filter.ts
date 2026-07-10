import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import { consumePrivateTraceResultMarker } from "@/chat/tool-support/private-trace-result";
import type * as Sentry from "@/chat/sentry";

type AttributeMap = Record<string, unknown>;
type AttributeContainer = {
  attributes?: AttributeMap;
  data?: AttributeMap;
};
type SentryErrorEvent = Parameters<
  NonNullable<Sentry.NodeOptions["beforeSend"]>
>[0];
type SentryTransactionEvent = Parameters<
  NonNullable<Sentry.NodeOptions["beforeSendTransaction"]>
>[0];
type SentrySpan = Parameters<Parameters<typeof Sentry.withStreamedSpan>[0]>[0];
type SentryLog = Parameters<
  NonNullable<Sentry.NodeOptions["beforeSendLog"]>
>[0];

const PAYLOAD_ATTRIBUTE_KEYS = new Set([
  "app.message.input",
  "app.message.output",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

function hasPayloadAttributes(attributes: AttributeMap): boolean {
  return Object.keys(attributes).some((key) => PAYLOAD_ATTRIBUTE_KEYS.has(key));
}

function shouldScrubPayloads(attributes: AttributeMap): boolean {
  if (!hasPayloadAttributes(attributes)) {
    return false;
  }
  return getCurrentConversationPrivacy() !== "public";
}

function scrubPayloadAttributes(attributes: AttributeMap | undefined): void {
  if (!attributes) {
    return;
  }

  if (!shouldScrubPayloads(attributes)) {
    return;
  }

  const preserveProjectedToolResult =
    consumePrivateTraceResultMarker(attributes);
  let redacted = false;
  for (const key of PAYLOAD_ATTRIBUTE_KEYS) {
    if (key === "gen_ai.tool.call.result" && preserveProjectedToolResult) {
      continue;
    }
    if (key in attributes) {
      redacted = true;
    }
    delete attributes[key];
  }
  if (redacted) {
    attributes["app.conversation.payload_redacted"] = true;
  }
}

function scrubContainer(container: AttributeContainer | undefined): void {
  if (!container) {
    return;
  }
  scrubPayloadAttributes(container.data);
  scrubPayloadAttributes(container.attributes);
}

/** Remove raw private conversation payloads from Sentry error events. */
export function scrubPrivateSentryEvent(
  event: SentryErrorEvent,
): SentryErrorEvent | null {
  const eventRecord = event as AttributeContainer;
  scrubContainer(eventRecord);
  scrubContainer(event.contexts?.trace as AttributeContainer);

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubContainer(breadcrumb as AttributeContainer);
  }

  return event;
}

/** Remove raw private conversation payloads from Sentry transaction events. */
export function scrubPrivateSentryTransaction(
  event: SentryTransactionEvent,
): SentryTransactionEvent | null {
  const eventRecord = event as AttributeContainer;
  scrubContainer(eventRecord);
  scrubContainer(event.contexts?.trace as AttributeContainer);

  for (const span of event.spans ?? []) {
    scrubContainer(span);
  }

  return event;
}

/** Remove raw private conversation payloads from streamed Sentry spans. */
export function scrubPrivateSentrySpan(span: SentrySpan): SentrySpan {
  scrubContainer(span);
  return span;
}

/** Remove raw private conversation payloads from Sentry structured logs. */
export function scrubPrivateSentryLog(log: SentryLog): SentryLog | null {
  scrubContainer(log);
  return log;
}
