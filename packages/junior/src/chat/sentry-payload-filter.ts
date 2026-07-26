import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import { consumePrivateTraceResultMarker } from "@/chat/tool-support/private-trace-result";
import type * as Sentry from "@/chat/sentry";

type AttributeMap = Record<string, unknown>;
type AttributeContainer = {
  attributes?: AttributeMap;
  data?: AttributeMap;
};
type RequestContainer = {
  data?: unknown;
  headers?: Record<string, unknown>;
  query_string?: unknown;
  url?: string;
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
const URL_ATTRIBUTE_KEYS = new Set([
  "http.target",
  "http.url",
  "url.full",
  "url.path",
]);
const OAUTH_CALLBACK_PATH = "/api/oauth/callback/";
const LOCAL_CREDENTIAL_PATH = "/api/internal/local-oauth-credentials";
const SECRET_HEADER_NAMES = new Set([
  "x-junior-local-credential-signature",
  "x-junior-sandbox-egress-token",
]);

function stripQuery(value: string): string {
  const queryIndex = value.indexOf("?");
  return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
}

function isSecretHeaderAttribute(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("xjuniorlocalcredentialsignature") ||
    normalized.endsWith("xjuniorsandboxegresstoken")
  );
}

function scrubSensitiveUrlAttributes(
  attributes: AttributeMap | undefined,
): void {
  if (!attributes) {
    return;
  }
  // Query strings are not useful enough in telemetry to justify retaining
  // OAuth codes, signed state, or other caller-supplied secrets.
  delete attributes["url.query"];

  const hasLocalCredentialUrl = [...URL_ATTRIBUTE_KEYS].some((key) => {
    const value = attributes[key];
    return typeof value === "string" && value.includes(LOCAL_CREDENTIAL_PATH);
  });
  for (const key of Object.keys(attributes)) {
    if (
      isSecretHeaderAttribute(key) ||
      (hasLocalCredentialUrl && key === "http.request.body.data")
    ) {
      delete attributes[key];
    }
  }
  for (const key of URL_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    if (typeof value !== "string" || !value.includes(OAUTH_CALLBACK_PATH)) {
      continue;
    }
    attributes[key] = stripQuery(value);
  }
}

function scrubSensitiveRequest(request: RequestContainer | undefined): void {
  if (!request) {
    return;
  }
  const url = request.url;
  if (url?.includes(OAUTH_CALLBACK_PATH)) {
    request.url = stripQuery(url);
    delete request.query_string;
  }
  if (url?.includes(LOCAL_CREDENTIAL_PATH)) {
    delete request.data;
  }
  if (!request.headers) {
    return;
  }
  for (const key of Object.keys(request.headers)) {
    if (SECRET_HEADER_NAMES.has(key.toLowerCase())) {
      delete request.headers[key];
    }
  }
}

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
  scrubSensitiveUrlAttributes(container.data);
  scrubSensitiveUrlAttributes(container.attributes);
}

/** Remove private conversation payloads and boundary secrets from error events. */
export function scrubPrivateSentryEvent(
  event: SentryErrorEvent,
): SentryErrorEvent | null {
  const eventRecord = event as AttributeContainer;
  scrubContainer(eventRecord);
  scrubSensitiveRequest(event.request as RequestContainer | undefined);
  scrubContainer(event.contexts?.trace as AttributeContainer);

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubContainer(breadcrumb as AttributeContainer);
  }

  return event;
}

/** Remove private conversation payloads and boundary secrets from transactions. */
export function scrubPrivateSentryTransaction(
  event: SentryTransactionEvent,
): SentryTransactionEvent | null {
  const eventRecord = event as AttributeContainer;
  scrubContainer(eventRecord);
  scrubSensitiveRequest(event.request as RequestContainer | undefined);
  scrubContainer(event.contexts?.trace as AttributeContainer);

  for (const span of event.spans ?? []) {
    scrubContainer(span);
  }

  return event;
}

/** Remove private conversation payloads and boundary secrets from streamed spans. */
export function scrubPrivateSentrySpan(span: SentrySpan): SentrySpan {
  scrubContainer(span);
  return span;
}

/** Remove private conversation payloads and boundary secrets from structured logs. */
export function scrubPrivateSentryLog(log: SentryLog): SentryLog | null {
  scrubContainer(log);
  return log;
}
