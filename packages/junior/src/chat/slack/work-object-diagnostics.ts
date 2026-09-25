import { isRecord } from "@/chat/coerce";
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
  "app_unfurl_url",
  "app_id",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "full_size_preview",
  "preview_url",
  "mime_type",
]);

// Keep validation language, not arbitrary provider prose. Slack nests error
// sentences inside quoted arrays, so removing every quoted string loses the cause.
const diagnosticWords = new Set(
  `WARN ERROR Message message metadata was incorrectly formatted The the will be
  ignored as a result For for event entity refer to following errors error
  missing required field fields property properties additional unexpected unknown
  unsupported invalid expected received actual type types must should match matches
  matching does not is are has have of at in on and or an only allowed allow
  value values string number integer boolean object array null minimum maximum
  length min max items item empty nonempty too long short large small size limit
  exceeded exceeds less greater than equal valid format schema validation failed
  failure cannot contain contains found one any all none enum pattern definition
  defined constraint constraints satisfy satisfies with without provided specified
  unrecognized unrecognised recognized recognised extraneous disallowed duplicate
  unique malformed nested root exactly needs need requires requirement supported
  json-pointer input different schema_uri schema_id schemas additionalProperties
  minLength maxLength minItems maxItems anyOf oneOf allOf`.split(/\s+/),
);

function summarizeDiagnostic(value: string): string {
  return value
    .slice(0, 2000)
    .replace(/\b(?:https?:\/\/|www\.)[^\s"'`<>]+/gi, "[value]")
    .replace(
      /\/[^\s"'`[\],;()]*|[\p{L}\p{N}\p{M}_]+(?:[-./:@=+%~][\p{L}\p{N}\p{M}_]+)*|[^\s\w[\]{}():,;."'`/*=<>!?+-]/gu,
      (token) => {
        if (token.startsWith("/")) {
          return token
            .split("/")
            .slice(0, 17)
            .map((part, index) =>
              index === 0 ? "" : pathFields.has(part) ? part : "*",
            )
            .join("/");
        }
        return codes.has(token) ||
          pathFields.has(token) ||
          diagnosticWords.has(token)
          ? token
          : "[value]";
      },
    )
    .replace(/\s+/g, " ")
    .slice(0, 2000);
}

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
  const summaries: Record<string, string[]> = {};
  // Apply the same allowlist in public, private, and unknown Conversations.
  for (const key of ["warnings", "messages"] as const) {
    const values = metadata[key];
    if (!Array.isArray(values)) continue;
    summaries[key] = values
      .slice(0, 20)
      .filter((value): value is string => typeof value === "string")
      .map(summarizeDiagnostic);
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
      "app.slack.response_diagnostics": summaries,
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
