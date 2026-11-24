// Why one model request failed. The client records what it saw on the wire,
// and the kind comes from the HTTP status and the provider's error type, not
// from the words of the error text.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import * as z from "zod";
import type { ConversationTurnFailureReason } from "@/chat/conversations/history";

/** The kinds of model failure. A Turn stores the kind as its failure reason. */
export type ModelFailureKind = Extract<
  ConversationTurnFailureReason,
  | "auth"
  | "permission"
  | "quota"
  | "rate_limit"
  | "capacity"
  | "timeout"
  | "network"
  | "server"
  | "invalid_request"
  | "invalid_response"
  | "content_policy"
  | "unknown"
>;

/** A failed model request. */
export type ModelFailure = {
  kind: ModelFailureKind;
  /** True when the same request can work later. */
  retryable: boolean;
  /** The HTTP status of the last response, when one arrived. */
  status?: number;
  /** The error type that the provider sent, such as `overloaded_error`. */
  providerType?: string;
  /** How long the provider asked the caller to wait before it tries again. */
  retryAfterMs?: number;
  /** A short description for telemetry. Never show it to a person. */
  message: string;
};

/** What the client saw of one model request on the wire. */
export type RequestObservation = {
  /** The last HTTP response that was not a success. */
  errorResponse?: {
    status: number;
    retryAfterMs?: number;
    errorType?: string;
    errorMessage?: string;
  };
  /** The name of the error that the fetch threw before a response arrived. */
  transportError?: string;
};

const RETRYABLE_KINDS = new Set<ModelFailureKind>([
  "rate_limit",
  "capacity",
  "timeout",
  "network",
  "server",
]);

// The error types of the Anthropic Messages API, which AI Gateway serves. See
// https://docs.anthropic.com/en/api/errors.
const KIND_BY_ERROR_TYPE: Readonly<Record<string, ModelFailureKind>> = {
  invalid_request_error: "invalid_request",
  authentication_error: "auth",
  billing_error: "quota",
  permission_error: "permission",
  not_found_error: "invalid_request",
  request_too_large: "invalid_request",
  rate_limit_error: "rate_limit",
  api_error: "server",
  timeout_error: "timeout",
  overloaded_error: "capacity",
};

// The stop reasons of a reply that the provider refused to give.
const REFUSAL_STOP_REASONS = new Set(["refusal", "sensitive"]);

const MESSAGE_MAX_CHARS = 240;

/**
 * The body of an Anthropic or AI Gateway error, in an error response or a
 * stream `error` event.
 */
export const providerErrorBodySchema = z.object({
  error: z.object({
    type: z.string().optional(),
    message: z.string().optional(),
  }),
});

function kindForStatus(status: number): ModelFailureKind {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 403) return "permission";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 529) return "capacity";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

function kindForTransportError(name: string): ModelFailureKind {
  return name === "TimeoutError" ? "timeout" : "network";
}

// Pi gives the data of a stream `error` event as the error text.
function streamErrorBody(reply: AssistantMessage) {
  if (!reply.errorMessage?.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = providerErrorBodySchema.safeParse(
      JSON.parse(reply.errorMessage),
    );
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

function shorten(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > MESSAGE_MAX_CHARS
    ? `${normalized.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : normalized;
}

/** Classifies the failure of a reply with stop reason `error` or `aborted`. */
export function classifyFailure(
  observed: RequestObservation,
  reply: AssistantMessage,
): ModelFailure {
  const response = observed.errorResponse;
  const streamError = response ? undefined : streamErrorBody(reply);
  const providerType = response?.errorType ?? streamError?.type;
  const kind: ModelFailureKind =
    reply.rawStopReason && REFUSAL_STOP_REASONS.has(reply.rawStopReason)
      ? "content_policy"
      : ((providerType ? KIND_BY_ERROR_TYPE[providerType] : undefined) ??
        (response ? kindForStatus(response.status) : undefined) ??
        (observed.transportError
          ? kindForTransportError(observed.transportError)
          : "unknown"));
  const message =
    response?.errorMessage ??
    streamError?.message ??
    reply.errorMessage ??
    `Model request ended with ${reply.stopReason}`;
  return {
    kind,
    retryable: RETRYABLE_KINDS.has(kind),
    ...(response ? { status: response.status } : undefined),
    ...(providerType ? { providerType } : undefined),
    ...(response?.retryAfterMs !== undefined
      ? { retryAfterMs: response.retryAfterMs }
      : undefined),
    message: shorten(message),
  };
}

/** The wait that a `retry-after-ms` or `retry-after` header asks for. */
export function retryAfterMs(headers: Headers): number | undefined {
  const milliseconds = Number.parseFloat(headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return milliseconds;
  }
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The error that core reports to Sentry for a failed model request. */
export class ModelRequestError extends Error {
  constructor(failure: ModelFailure) {
    super(`Model request failed: ${failure.kind}`);
    this.name = "ModelRequestError";
  }
}

/** The span and log attributes of a failure, with main's names. */
export function modelFailureAttributes(
  failure: ModelFailure,
): Record<string, string | number | boolean> {
  return {
    "app.ai.provider_error.kind": failure.kind,
    "app.ai.provider_error.retryable": failure.retryable,
    "app.ai.provider_error.summary": failure.message,
    ...(failure.status !== undefined
      ? { "app.ai.provider_error.status": failure.status }
      : undefined),
    ...(failure.providerType
      ? { "app.ai.provider_error.type": failure.providerType }
      : undefined),
    ...(failure.retryAfterMs !== undefined
      ? { "app.ai.provider_error.retry_after_ms": failure.retryAfterMs }
      : undefined),
  };
}
