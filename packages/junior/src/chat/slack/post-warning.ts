import type { ChatPostMessageResponse } from "@slack/web-api";
import { getLogContextAttributes, setSpanAttributes } from "@/chat/logging";
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

/** Report Slack warnings once, on the request span, without retrying the post. */
export function captureSlackPostWarning(
  response: ChatPostMessageResponse,
  attributes: Record<string, unknown>,
): void {
  const warnings = response.response_metadata?.warnings ?? [];
  const messages = response.response_metadata?.messages ?? [];
  const knownCodes = [
    ...new Set(warnings.slice(0, 20).filter((code) => codes.has(code))),
  ].sort();
  const diagnostics = {
    "app.slack.warning_count": warnings.length,
    "app.slack.response_message_count": messages.length,
    "app.slack.diagnostic_codes": knownCodes,
  };
  setSpanAttributes(diagnostics);
  if (!warnings.length && !messages.length) return;

  captureMessage("Slack chat.postMessage returned warnings", {
    level: "warning",
    fingerprint: [
      "slack.chat.postMessage.warning",
      ...(knownCodes.length ? knownCodes : ["unknown"]),
    ],
    tags: { "app.slack.method": "chat.postMessage" },
    extra: {
      ...getLogContextAttributes(),
      ...attributes,
      ...diagnostics,
      // Apply the same bounded allowlist in every Conversation, including DMs.
      "app.slack.response_diagnostics": {
        warnings: warnings.slice(0, 20).map(summarizeDiagnostic),
        messages: messages.slice(0, 20).map(summarizeDiagnostic),
      },
    },
  });
}
