import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import { redactSandboxEgressProxyPath } from "@/chat/sandbox/egress/proxy-path";
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
type SentrySpan = Parameters<
  NonNullable<Sentry.NodeOptions["beforeSendSpan"]>
>[0];
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
  // Fetch and HTTP breadcrumbs keep the request URL under `url`.
  "url",
  "url.full",
  "url.path",
]);
const SLACK_FILE_HOST = "files.slack.com";
// `initSentry` collects only allowlisted request headers. This also covers a
// changed SDK default. `forwarded` carries a Vercel bearer in `sig=`, and
// `vercel-forwarded-path` and `referer` repeat paths with their query strings.
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "forwarded",
  "referer",
  "vercel-forwarded-path",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-junior-local-credential-signature",
  "x-junior-sandbox-egress-token",
  "x-slack-signature",
]);
const SDK_REQUEST_HEADER_PREFIX = "http.request.header.";

// Span names such as `GET https://slack.com/api/users.info?user=U1` repeat the
// request URL. Query spans use `?` placeholders, so only method-and-URL names
// are rewritten.
const URL_SPAN_NAME = /^([A-Z]+ )((?:https?:\/\/|\/)\S*)$/;

/** Drop the query and fragment, and hide the sandbox egress credential token. */
function scrubUrl(value: string): string {
  return redactSandboxEgressProxyPath(value.split(/[?#]/, 1)[0] ?? value);
}

function scrubSpanName(name: string): string {
  const match = URL_SPAN_NAME.exec(name);
  return match ? `${match[1]}${scrubUrl(match[2] ?? "")}` : name;
}

function isSecretHeaderAttribute(key: string): boolean {
  // Logs write header names with underscores, such as `x_slack_signature`.
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.startsWith(SDK_REQUEST_HEADER_PREFIX) &&
    SECRET_HEADER_NAMES.has(
      lowerKey.slice(SDK_REQUEST_HEADER_PREFIX.length).replaceAll("_", "-"),
    )
  ) {
    return true;
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.endsWith("xjuniorlocalcredentialsignature") ||
    normalized.endsWith("xjuniorsandboxegresstoken")
  );
}

function isSlackFileRequest(attributes: AttributeMap): boolean {
  return (
    attributes["server.address"] === SLACK_FILE_HOST ||
    [...URL_ATTRIBUTE_KEYS].some((key) => {
      const value = attributes[key];
      return (
        typeof value === "string" && value.includes(`//${SLACK_FILE_HOST}/`)
      );
    })
  );
}

/** Keep only the host of private Slack file URLs, which name the workspace and file. */
function scrubSlackFileUrls(attributes: AttributeMap): void {
  for (const key of URL_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    if (typeof value !== "string") {
      continue;
    }
    if (value.includes("://")) {
      attributes[key] = `https://${SLACK_FILE_HOST}`;
    } else {
      delete attributes[key];
    }
  }
}

function scrubSensitiveUrlAttributes(
  attributes: AttributeMap | undefined,
): void {
  if (!attributes) {
    return;
  }
  // Query strings and fragments are not useful enough in telemetry to justify
  // retaining OAuth codes, signed state, or other caller-supplied secrets.
  delete attributes["url.query"];
  delete attributes["url.fragment"];
  // `initSentry` collects no bodies. This also covers a changed SDK default.
  delete attributes["http.request.body.data"];

  for (const key of Object.keys(attributes)) {
    if (isSecretHeaderAttribute(key)) {
      delete attributes[key];
    }
  }
  if (isSlackFileRequest(attributes)) {
    scrubSlackFileUrls(attributes);
    return;
  }
  for (const key of URL_ATTRIBUTE_KEYS) {
    const value = attributes[key];
    if (typeof value === "string") {
      attributes[key] = scrubUrl(value);
    }
  }
}

function scrubSensitiveRequest(request: RequestContainer | undefined): void {
  if (!request) {
    return;
  }
  const url = request.url;
  if (url !== undefined) {
    request.url = scrubUrl(url);
  }
  delete request.query_string;
  delete request.data;
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
  if (event.transaction) {
    event.transaction = scrubSpanName(event.transaction);
  }
  scrubContainer(event.contexts?.trace as AttributeContainer);

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubContainer(breadcrumb as AttributeContainer);
  }

  return event;
}

/** Remove private conversation payloads and boundary secrets from streamed spans. */
export function scrubPrivateSentrySpan(span: SentrySpan): SentrySpan {
  scrubContainer(span);
  span.name = scrubSpanName(span.name);
  // The SDK copies the raw segment name onto every span before this callback.
  const segmentName = span.attributes?.["sentry.segment.name"];
  if (span.attributes && typeof segmentName === "string") {
    span.attributes["sentry.segment.name"] = scrubSpanName(segmentName);
  }
  return span;
}

/** Remove private conversation payloads and boundary secrets from structured logs. */
export function scrubPrivateSentryLog(log: SentryLog): SentryLog | null {
  scrubContainer(log);
  return log;
}
