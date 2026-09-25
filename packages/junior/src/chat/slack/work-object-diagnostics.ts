import { isRecord } from "@/chat/coerce";

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
