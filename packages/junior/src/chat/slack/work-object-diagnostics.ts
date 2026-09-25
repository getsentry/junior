import { isRecord } from "@/chat/coerce";
import { getCurrentConversationPrivacy } from "@/chat/conversation-privacy";
import { getLogContextAttributes } from "@/chat/logging";
import { captureMessage } from "@/chat/sentry";

// Slack can quote submitted values. Keep only known codes and schema keys.
const codes = new Set([
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "metadata_too_large",
  "invalid_arguments",
  "invalid_blocks",
  "missing_scope",
  "missing_charset",
  "superfluous_charset",
  "message_truncated",
]);
const pathFields = new Set([
  "metadata",
  "event_type",
  "event_payload",
  "entities",
  "entity_type",
  "entity_payload",
  "external_ref",
  "id",
  "type",
  "url",
  "attributes",
  "title",
  "text",
  "display_id",
  "display_type",
  "product_name",
  "fields",
  "status",
  "custom_fields",
  "key",
  "label",
  "value",
  "long",
  "format",
  "link",
  "display_order",
]);

/** Capture accepted Slack response warnings without turning them into retries. */
export function captureSlackPostWarning(
  response: unknown,
  attributes: Record<string, unknown>,
  diagnostics: ReturnType<typeof slackWorkObjectDiagnostics>,
): void {
  if (
    diagnostics["app.slack.warning_count"] === 0 &&
    diagnostics["app.slack.response_message_count"] === 0
  ) {
    return;
  }
  const metadata =
    isRecord(response) && isRecord(response.response_metadata)
      ? response.response_metadata
      : {};
  const publicText = getCurrentConversationPrivacy() === "public";
  const summaries: Record<string, string[]> = {};
  if (publicText) {
    // Only these diagnostic fields may contain public excerpts, never the response body.
    for (const key of ["warnings", "messages"] as const) {
      const values = metadata[key];
      if (!Array.isArray(values)) continue;
      summaries[key] = values
        .slice(0, 20)
        .filter((value): value is string => typeof value === "string")
        .map((value) =>
          value
            .slice(0, 2000)
            .replace(
              /(["'`])([^\n]*?)\1/g,
              (_match, quote: string, text: string) =>
                pathFields.has(text) ? `${quote}${text}${quote}` : "[value]",
            )
            .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[url]")
            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
            .replace(/\b(?:xox[baprs]-|sk-)[A-Za-z0-9_-]+/g, "[token]")
            .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
            .replace(
              /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|authorization|cookie)\s*[=:]\s*\S+/gi,
              "[credential]",
            )
            .replace(/\s+/g, " ")
            .slice(0, 2000),
        );
    }
  }
  const knownCodes = diagnostics["app.slack.diagnostic_codes"];
  captureMessage("Slack chat.postMessage returned warnings", {
    level: "warning",
    fingerprint: [
      "slack.chat.postMessage.warning",
      ...(knownCodes.length ? [...knownCodes].sort() : ["unknown"]),
    ],
    tags: { "app.slack.method": "chat.postMessage" },
    extra: {
      ...getLogContextAttributes(),
      ...attributes,
      ...diagnostics,
      "app.slack.diagnostic_text_omitted": !publicText,
      ...(publicText
        ? { "app.slack.response_diagnostics": summaries }
        : undefined),
    },
  });
}

/** Summarize Slack response diagnostics without retaining submitted values. */
export function slackWorkObjectDiagnostics(response: unknown) {
  const metadata =
    isRecord(response) && isRecord(response.response_metadata)
      ? response.response_metadata
      : {};
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings : [];
  const messages = Array.isArray(metadata.messages) ? metadata.messages : [];
  const knownCodes = new Set<string>();
  const paths = new Set<string>();
  let unrecognized = 0;
  const diagnostics = [...warnings.slice(0, 20), ...messages.slice(0, 20)];
  let truncated = warnings.length > 20 || messages.length > 20;
  for (const diagnostic of diagnostics) {
    if (typeof diagnostic !== "string") {
      unrecognized++;
      continue;
    }
    truncated ||= diagnostic.length > 2000;
    const text = diagnostic.slice(0, 2000);
    const code = text.replace(/^\[(?:WARN|ERROR)\]\s*/, "").split(/[\s:]/)[0];
    if (code && codes.has(code)) knownCodes.add(code);
    else unrecognized++;
    // Best effort: Slack does not guarantee a format for human-readable messages.
    for (const match of text.matchAll(/\[json-pointer:(\/[^\]\s]*)\]/g)) {
      const segments = match[1]!.split("/").slice(1);
      truncated ||= segments.length > 16;
      paths.add(
        "/" +
          segments
            .slice(0, 16)
            .map((part) => (pathFields.has(part) ? part : "*"))
            .join("/"),
      );
      if (paths.size >= 20) {
        truncated = true;
        break;
      }
    }
    if (paths.size >= 20) break;
  }
  const message =
    isRecord(response) && isRecord(response.message) ? response.message : {};
  const returnedMetadata = isRecord(message.metadata) ? message.metadata : {};
  return {
    "app.slack.warning_count": warnings.length,
    "app.slack.response_message_count": messages.length,
    "app.slack.diagnostic_codes": [...knownCodes],
    "app.slack.diagnostic_paths": [...paths],
    "app.slack.unrecognized_diagnostic_count": unrecognized,
    "app.slack.diagnostics_truncated": truncated,
    "app.slack.work_object.response_entities_present": Array.isArray(
      returnedMetadata.entities,
    ),
    ...(Array.isArray(returnedMetadata.entities)
      ? {
          "app.slack.work_object.response_entity_count":
            returnedMetadata.entities.length,
        }
      : undefined),
  };
}
