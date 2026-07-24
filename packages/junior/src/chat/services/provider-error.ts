export type ProviderErrorKind =
  | "auth"
  | "permission"
  | "rate_limit"
  | "capacity"
  | "timeout"
  | "network"
  | "server"
  | "invalid_request"
  | "quota"
  | "content_policy"
  | "unknown";

interface ProviderErrorContext {
  modelId?: string;
}

interface ProviderErrorDetails extends ProviderErrorContext {
  kind: ProviderErrorKind;
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

  constructor(message: string, details: ProviderErrorDetails, cause?: unknown) {
    super(`AI provider error: ${message || "Unknown provider error"}`, {
      cause,
    });
    this.name = "ProviderError";
    this.kind = details.kind;
    this.modelId = details.modelId;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
    this.status = details.status;
  }
}

type ErrorShape = Error & {
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

function providerMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

function extractTransportKind(
  error: unknown,
  depth = 0,
): ProviderErrorKind | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;

  const shaped = error as ErrorShape;
  const code =
    typeof shaped.code === "string" ? shaped.code.toUpperCase() : undefined;
  if (code && TIMEOUT_ERROR_CODES.has(code)) return "timeout";
  if (code && NETWORK_ERROR_CODES.has(code)) return "network";
  return extractTransportKind(shaped.cause, depth + 1);
}

function extractStatus(error: unknown, message: string): number | undefined {
  if (error instanceof Error) {
    const shaped = error as ErrorShape;
    if (typeof shaped.status === "number") return shaped.status;
    if (typeof shaped.statusCode === "number") return shaped.statusCode;
  }

  const match = message.match(
    /^(?:Error:\s*)?([45]\d\d)\b|\bstatus(?:Code)?["'=:\s]+([45]\d\d)\b/i,
  );
  const status = match?.[1] ?? match?.[2];
  return status ? Number(status) : undefined;
}

function extractMessageField(
  message: string,
  field: string,
): string | undefined {
  return message.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "i"))?.[1];
}

function extractRetryAfterMs(
  error: unknown,
  message: string,
): number | undefined {
  const headers =
    error instanceof Error
      ? ((error as ErrorShape).responseHeaders ??
        (error as ErrorShape).response?.headers)
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

function classifyProviderError(
  status: number | undefined,
  message: string,
  transportKind: ProviderErrorKind | undefined,
): ProviderErrorKind {
  if (
    /\b(?:content|safety)[ _-]?policy\b|\b(?:content|safety) (?:filter|violation)\b|\bmoderation (?:blocked|rejected|refused)\b/i.test(
      message,
    )
  ) {
    return "content_policy";
  }
  if (
    /insufficient.?quota|quota exceeded|usage limit|monthly usage limit|available balance|out of budget|billing/i.test(
      message,
    )
  ) {
    return "quota";
  }
  if (
    status === 401 ||
    /invalid.?api.?key|no api key|authentication|(?:invalid|missing|expired|revoked).{0,24}\bcredentials?\b|\bcredentials?\b.{0,24}(?:invalid|missing|expired|revoked)|\bno\b.{0,16}\bcredentials?\b/i.test(
      message,
    )
  ) {
    return "auth";
  }
  if (status === 403 || /permission|forbidden|authorization/i.test(message)) {
    return "permission";
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (/overloaded|at capacity|capacity exceeded/i.test(message)) {
    return "capacity";
  }
  if (
    transportKind === "timeout" ||
    /timed? out|timeout|gateway timeout/i.test(message)
  ) {
    return "timeout";
  }
  if (
    transportKind === "network" ||
    /network.?error|connection|fetch failed|socket|stream ended|ended before|\bterminated\b|ECONNRESET/i.test(
      message,
    )
  ) {
    return "network";
  }
  if (
    (status !== undefined && status >= 500) ||
    /service(?: temporarily)?[ _-]?unavailable|internal server error|bad gateway|upstream (?:request )?failed|unexpected error occurred/i.test(
      message,
    )
  ) {
    return "server";
  }
  if (
    (status !== undefined && status >= 400) ||
    /context.?length|context.?window|validation|bad request|unsupported model|invalid model|unknown (?:ai gateway )?model|mismatched api/i.test(
      message,
    )
  ) {
    return "invalid_request";
  }
  return "unknown";
}

/** Normalize SDK, Gateway, and Pi failures into one provider error contract. */
export function createProviderError(
  error: unknown,
  context: ProviderErrorContext = {},
): ProviderError {
  if (error instanceof ProviderError) return error;

  const message = providerMessage(error);
  const status = extractStatus(error, message);
  const kind = classifyProviderError(
    status,
    message,
    extractTransportKind(error),
  );
  return new ProviderError(
    message,
    {
      kind,
      modelId:
        context.modelId ?? extractMessageField(message, "originalModelId"),
      retryable:
        Boolean(message) &&
        ["rate_limit", "capacity", "timeout", "network", "server"].includes(
          kind,
        ),
      retryAfterMs: extractRetryAfterMs(error, message),
      status,
    },
    error,
  );
}

/** Return whether a provider-boundary error should be retried. */
export function isProviderRetryError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable;
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
    case "permission":
      return "The model provider rejected Junior's credentials. This needs an administrator or configuration fix.";
    case "quota":
      return "The model provider's usage quota has been exhausted. This needs an administrator or billing configuration fix.";
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
      : {}),
    ...(error.retryAfterMs !== undefined
      ? { "app.ai.provider_error.retry_after_ms": error.retryAfterMs }
      : {}),
    ...(error.modelId ? { "gen_ai.request.model": error.modelId } : {}),
  };
}
