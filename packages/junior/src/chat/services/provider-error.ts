/**
 * Normalize failures at the model-provider boundary.
 *
 * Junior owns stable failure kinds, safe user copy, and telemetry fields. Pi
 * remains the source of truth for retrying assistant error messages.
 */

export type ProviderErrorKind =
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

interface ProviderErrorOptions {
  kind?: ProviderErrorKind;
  modelId?: string;
  /** Pi's decision for an assistant error; explicit terminal kinds still win. */
  retryable?: boolean;
}

interface ProviderErrorDetails {
  cause?: unknown;
  kind: ProviderErrorKind;
  modelId?: string;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
}

/** Structured failure produced at an AI provider boundary. */
export class ProviderError extends Error {
  readonly code = "provider_error";
  readonly kind: ProviderErrorKind;
  readonly modelId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(details: ProviderErrorDetails) {
    super(
      `AI provider error: ${details.kind}`,
      details.cause !== undefined ? { cause: details.cause } : {},
    );
    this.name = "ProviderError";
    this.kind = details.kind;
    this.modelId = details.modelId;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
    this.status = details.status;
  }
}

type ProviderErrorFields = Error & {
  cause?: unknown;
  code?: unknown;
  response?: { headers?: unknown };
  responseHeaders?: unknown;
  status?: unknown;
  statusCode?: unknown;
};

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "ESOCKETTIMEDOUT",
]);

const CONTENT_POLICY_PATTERN =
  /\b(?:content|safety)[ _-]?policy\b|\b(?:content|safety) (?:filter|violation)\b|\bmoderation (?:blocked|rejected|refused)\b/i;
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

function providerMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

function extractTransportKind(
  error: unknown,
  depth = 0,
): ProviderErrorKind | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;

  const providerError = error as ProviderErrorFields;
  const code =
    typeof providerError.code === "string" ? providerError.code.toUpperCase() : undefined;
  if (code && TIMEOUT_ERROR_CODES.has(code)) return "timeout";
  if (code && NETWORK_ERROR_CODES.has(code)) return "network";
  return extractTransportKind(providerError.cause, depth + 1);
}

function extractStatus(error: unknown, message: string): number | undefined {
  if (error instanceof Error) {
    const providerError = error as ProviderErrorFields;
    if (typeof providerError.status === "number") return providerError.status;
    if (typeof providerError.statusCode === "number") return providerError.statusCode;
  }

  const match = message.match(
    /^(?:Error:\s*)?([45]\d\d)\b|\bstatus(?:Code)?["'=:\s]+([45]\d\d)\b/i,
  );
  const status = match?.[1] ?? match?.[2];
  return status ? Number(status) : undefined;
}

function extractRetryAfterMs(
  error: unknown,
  message: string,
): number | undefined {
  const headers =
    error instanceof Error
      ? ((error as ProviderErrorFields).responseHeaders ??
        (error as ProviderErrorFields).response?.headers)
      : undefined;
  const retryAfter =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers && typeof headers === "object"
        ? Object.entries(headers as Record<string, unknown>).find(
            ([name]) => name.toLowerCase() === "retry-after",
          )?.[1]
        : undefined;
  const raw =
    typeof retryAfter === "string" || typeof retryAfter === "number"
      ? String(retryAfter)
      : message.match(/"retry-after"\s*:\s*"?([^",}]+)"?/i)?.[1];
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

/** Normalize SDK, Gateway, and Pi failures into one provider error contract. */
export function createProviderError(
  error: unknown,
  options: ProviderErrorOptions = {},
): ProviderError {
  if (error instanceof ProviderError) return error;

  const message = providerMessage(error);
  const status = extractStatus(error, message);
  const kind =
    options.kind ??
    classifyProviderError(status, message, extractTransportKind(error));
  const retryable =
    !TERMINAL_KINDS.has(kind) &&
    (options.retryable ?? RETRYABLE_KINDS.has(kind));
  return new ProviderError({
    cause: error,
    kind,
    modelId: options.modelId,
    retryable,
    retryAfterMs: extractRetryAfterMs(error, message),
    status,
  });
}

/** Return whether a provider-boundary error should be retried. */
export function isProviderRetryError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable;
}

/** Find the provider failure preserved inside a domain error cause chain. */
export function findProviderError(error: unknown): ProviderError | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ProviderError) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  return undefined;
}

/** Return stable, sanitized copy suitable for a terminal user response. */
export function getProviderErrorUserMessage(error: ProviderError): string {
  switch (error.kind) {
    case "capacity":
      return "The selected model is temporarily unavailable because it is at capacity. Please try again shortly.";
    case "rate_limit": {
      const seconds = error.retryAfterMs
        ? Math.max(1, Math.ceil(error.retryAfterMs / 1_000))
        : undefined;
      return seconds
        ? `The model is rate-limited. Please try again in about ${seconds} seconds.`
        : "The model is rate-limited. Please try again shortly.";
    }
    case "timeout":
    case "network":
    case "server":
      return "The model provider had a temporary connection problem. Please try again.";
    case "auth":
      return "The model provider rejected Junior's credentials. This needs an administrator or configuration fix.";
    case "permission":
      return "The model provider denied access to this model or request. Ask an administrator to check model access, organization policy, and region availability.";
    case "quota":
      return "The model provider's usage quota has been exhausted. This needs an administrator or billing configuration fix.";
    case "content_policy":
      return "The model provider blocked this request under its content policy. Please revise the request and try again.";
    case "invalid_request":
      return "The model provider rejected this request as invalid. Please revise the request or ask an administrator to check the model configuration.";
    case "invalid_response":
      return "The model provider returned an invalid response. Please try again.";
    default:
      return "";
  }
}

/** Return safe structured fields for terminal failure telemetry. */
export function getProviderErrorAttributes(
  error: ProviderError,
): Record<string, unknown> {
  return {
    "app.ai.provider_error.kind": error.kind,
    "app.ai.provider_error.retryable": error.retryable,
    ...(error.status !== undefined
      ? { "app.ai.provider_error.status": error.status }
      : undefined),
    ...(error.retryAfterMs !== undefined
      ? { "app.ai.provider_error.retry_after_ms": error.retryAfterMs }
      : undefined),
    ...(error.modelId ? { "gen_ai.request.model": error.modelId } : undefined),
  };
}
