// Port of the parts of chat/services/provider-error.ts that the attributes of a
// failed model reply need. A failed reply carries only its error text, so this
// reads status and retry-after from the text, as chat does for a string. Keep
// the two in step with the core-drift skill.
import type { AssistantMessage } from "@earendil-works/pi-ai";

type ProviderErrorKind =
  | "auth"
  | "permission"
  | "rate_limit"
  | "capacity"
  | "timeout"
  | "network"
  | "server"
  | "invalid_request"
  | "invalid_response"
  | "quota"
  | "content_policy"
  | "unknown";

// Provider and SDK text changes without notice. These patterns only select
// retry behavior and more specific user copy. An unmatched provider failure
// stays a ProviderError and gets generic provider copy. Never show raw text.
const CONTENT_POLICY_PATTERN =
  /\b(?:content|safety|usage)[ _-]?policy\b|\b(?:content|safety) (?:filter|violation)\b|\bmoderation (?:blocked|rejected|refused)\b/i;
const QUOTA_PATTERN =
  /insufficient.?quota|quota exceeded|usage limit|available balance|out of budget|billing (?:limit|quota|error)|payment required/i;
const AUTH_PATTERN =
  /unauthenticated|invalid.?api.?key|no api key|authentication (?:failed|error|required)|(?:invalid|missing|expired|revoked).{0,24}\bcredentials?\b|\bcredentials?\b.{0,24}(?:invalid|missing|expired|revoked)|\bno\b.{0,16}\bcredentials?\b/i;
const PERMISSION_PATTERN =
  /permission denied|forbidden|not authorized|authorization (?:failed|required|denied)/i;
const INVALID_REQUEST_PATTERN =
  /context.?length|context.?window|validation (?:error|failed)|bad request|unsupported model|invalid model|unknown (?:ai gateway )?model|mismatched api/i;
const CAPACITY_PATTERN = /overloaded|at capacity|capacity exceeded/i;
const TIMEOUT_PATTERN = /timed? out|timeout|gateway timeout/i;
const NETWORK_PATTERN =
  /network.?error|connection (?:error|refused|lost|closed)|fetch failed|socket (?:hang up|closed)|stream ended before/i;
const SERVER_PATTERN =
  /service(?: temporarily)?[ _-]?unavailable|server.?error|internal.?error|bad gateway|upstream (?:request )?failed/i;
const TERMINAL_KINDS = new Set<ProviderErrorKind>([
  "auth",
  "permission",
  "invalid_request",
  "invalid_response",
  "quota",
  "content_policy",
]);
const RETRYABLE_KINDS = new Set<ProviderErrorKind>([
  "rate_limit",
  "capacity",
  "timeout",
  "network",
  "server",
]);

const PROVIDER_ERROR_SUMMARY_MAX_CHARS = 240;

/** Short provider-boundary text for telemetry. Drop trailing JSON bodies. */
function summarizeProviderErrorMessage(message: string): string | undefined {
  const normalized = message.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;

  // Gateway errors often look like `503 {"error":...}`. Keep the lead text.
  const jsonStart = normalized.indexOf("{");
  const summary = (
    jsonStart >= 0 ? normalized.slice(0, jsonStart) : normalized
  ).trim();
  if (!summary) return undefined;
  return summary.length > PROVIDER_ERROR_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, PROVIDER_ERROR_SUMMARY_MAX_CHARS)}...`
    : summary;
}

function extractStatus(message: string): number | undefined {
  const match = message.match(
    /^(?:Error:\s*)?([45]\d\d)\b|\bstatus(?:Code)?["'=:\s]+([45]\d\d)\b/i,
  );
  const status = match?.[1] ?? match?.[2];
  return status ? Number(status) : undefined;
}

function extractRetryAfterMs(message: string): number | undefined {
  const raw = message.match(/"retry-after"\s*:\s*"?([^",}]+)"?/i)?.[1];
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Classify stable provider signals without copying Pi's retry vocabulary. */
function classifyProviderError(
  status: number | undefined,
  message: string,
  transportKind: ProviderErrorKind | undefined,
): ProviderErrorKind {
  if (CONTENT_POLICY_PATTERN.test(message)) return "content_policy";
  if (QUOTA_PATTERN.test(message)) return "quota";
  if (status === 401 || AUTH_PATTERN.test(message)) return "auth";
  if (status === 403 || PERMISSION_PATTERN.test(message)) return "permission";
  if (INVALID_REQUEST_PATTERN.test(message)) return "invalid_request";
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (status === 408) return "timeout";
  if (CAPACITY_PATTERN.test(message)) return "capacity";
  if (transportKind === "timeout" || TIMEOUT_PATTERN.test(message))
    return "timeout";
  if (transportKind === "network" || NETWORK_PATTERN.test(message))
    return "network";
  if ((status !== undefined && status >= 500) || SERVER_PATTERN.test(message)) {
    return "server";
  }
  if (status !== undefined && status >= 400) {
    return "invalid_request";
  }
  return "unknown";
}

// Anthropic ends a refused stream with stop reason `refusal` or `sensitive`,
// for example when its cyber safeguards flag a message. Pi maps both to an
// error and keeps the provider reason in `rawStopReason`.
const REFUSAL_STOP_REASONS = new Set(["refusal", "sensitive"]);

/**
 * The provider error attributes of a failed model reply, and its error kind
 * for `error.type`. A provider refusal is a content policy block.
 */
export function providerErrorAttributes(
  message: Pick<AssistantMessage, "errorMessage" | "rawStopReason">,
): {
  kind: ProviderErrorKind;
  attributes: Record<string, string | number | boolean>;
} {
  const text = (message.errorMessage ?? "").trim();
  const status = extractStatus(text);
  const kind =
    message.rawStopReason !== undefined &&
    REFUSAL_STOP_REASONS.has(message.rawStopReason)
      ? "content_policy"
      : classifyProviderError(status, text, undefined);
  const retryable = !TERMINAL_KINDS.has(kind) && RETRYABLE_KINDS.has(kind);
  const retryAfterMs = extractRetryAfterMs(text);
  const summary = summarizeProviderErrorMessage(message.errorMessage ?? "");
  return {
    kind,
    attributes: {
      "app.ai.provider_error.kind": kind,
      "app.ai.provider_error.retryable": retryable,
      ...(status !== undefined
        ? { "app.ai.provider_error.status": status }
        : undefined),
      ...(retryAfterMs !== undefined
        ? { "app.ai.provider_error.retry_after_ms": retryAfterMs }
        : undefined),
      ...(summary ? { "app.ai.provider_error.summary": summary } : undefined),
    },
  };
}
