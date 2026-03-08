import * as Sentry from "@sentry/nextjs";
import {
  createLogContextFromRequest,
  log,
  setLogContext,
  setSentryScopeContext,
  setSentryTagsFromContext,
  toSpanAttributes,
  withLogContext,
  type LogContext
} from "@/chat/logging";

export interface ObservabilityContext extends LogContext {}
export interface ErrorReference {
  traceId: string;
  eventId?: string;
}

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | string[];

function toSpanAttributeValue(value: unknown): SpanAttributeValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const sanitized = value.filter((entry): entry is string => typeof entry === "string");
  return sanitized.length > 0 ? sanitized : undefined;
}

function toContextAndAttributes(
  context: ObservabilityContext,
  attributes: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...toSpanAttributes(context),
    ...attributes
  };
}

export function captureException(error: unknown, context: ObservabilityContext = {}): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception("exception_captured", normalizedError, toContextAndAttributes(context, {}), "Captured exception");
}

function logWithLevel(
  level: "info" | "warn" | "error",
  eventName: string,
  attributes: Record<string, unknown> = {},
  body?: string
): void {
  if (level === "info") {
    log.info(eventName, attributes, body);
    return;
  }
  if (level === "warn") {
    log.warn(eventName, attributes, body);
    return;
  }
  log.error(eventName, attributes, body);
}

export function logInfo(
  eventName: string,
  context: ObservabilityContext = {},
  attributes: Record<string, unknown> = {},
  body?: string
): void {
  logWithLevel("info", eventName, toContextAndAttributes(context, attributes), body);
}

export function logWarn(
  eventName: string,
  context: ObservabilityContext = {},
  attributes: Record<string, unknown> = {},
  body?: string
): void {
  logWithLevel("warn", eventName, toContextAndAttributes(context, attributes), body);
}

export function logError(
  eventName: string,
  context: ObservabilityContext = {},
  attributes: Record<string, unknown> = {},
  body?: string
): void {
  logWithLevel("error", eventName, toContextAndAttributes(context, attributes), body);
}

export function logException(
  error: unknown,
  eventName: string,
  context: ObservabilityContext = {},
  attributes: Record<string, unknown> = {},
  body?: string
): string | undefined {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  return log.exception(eventName, normalizedError, toContextAndAttributes(context, attributes), body);
}

export function setTags(context: ObservabilityContext = {}): void {
  setLogContext(context);
  setSentryTagsFromContext(context);
}

export function createRequestContext(request: Request, context: Partial<ObservabilityContext> = {}): ObservabilityContext {
  return createLogContextFromRequest(request, context);
}

export async function withContext<T>(context: ObservabilityContext, callback: () => Promise<T>): Promise<T> {
  return withLogContext(context, callback);
}

export async function withSpan<T>(
  name: string,
  op: string,
  context: ObservabilityContext,
  callback: () => Promise<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const normalizedAttributes: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalizedValue = toSpanAttributeValue(value);
    if (normalizedValue !== undefined) {
      normalizedAttributes[key] = normalizedValue;
    }
  }

  return withLogContext(context, () =>
    Sentry.startSpan(
      {
        name,
        op,
        attributes: {
          ...toSpanAttributes(context),
          ...normalizedAttributes
        }
      },
      callback
    )
  );
}

export function setSpanAttributes(attributes: Record<string, unknown>): void {
  const sentry = Sentry as unknown as { getActiveSpan?: () => unknown };
  const span = sentry.getActiveSpan?.();
  if (!span) {
    return;
  }

  const setAttribute = (span as { setAttribute?: (key: string, value: SpanAttributeValue) => void }).setAttribute;
  if (typeof setAttribute !== "function") {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    const normalizedValue = toSpanAttributeValue(value);
    if (normalizedValue !== undefined) {
      setAttribute.call(span, key, normalizedValue);
    }
  }
}

export function setSpanStatus(status: "ok" | "error"): void {
  const sentry = Sentry as unknown as { getActiveSpan?: () => unknown };
  const span = sentry.getActiveSpan?.();
  if (!span) {
    return;
  }

  const setStatus = (span as { setStatus?: (value: string) => void }).setStatus;
  if (typeof setStatus !== "function") {
    return;
  }

  setStatus.call(span, status === "ok" ? "ok" : "internal_error");
}

export function captureExceptionInScope(error: unknown, context: ObservabilityContext = {}): void {
  const sentryWithScope = (Sentry as unknown as {
    withScope?: (callback: (scope: Sentry.Scope) => void) => void;
  }).withScope;
  const sentryCaptureException = (Sentry as unknown as {
    captureException?: (error: unknown) => unknown;
  }).captureException;
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  if (typeof sentryWithScope === "function" && typeof sentryCaptureException === "function") {
    sentryWithScope((scope) => {
      setSentryScopeContext(scope, context);
      sentryCaptureException(normalizedError);
    });
    return;
  }

  if (typeof sentryCaptureException === "function") {
    sentryCaptureException(normalizedError);
  }
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function getActiveTraceId(): string | undefined {
  const sentry = Sentry as unknown as {
    getActiveSpan?: () => unknown;
    spanToJSON?: (span: unknown) => { trace_id?: string };
  };
  if (typeof sentry.getActiveSpan !== "function" || typeof sentry.spanToJSON !== "function") {
    return undefined;
  }

  try {
    const span = sentry.getActiveSpan();
    if (!span) {
      return undefined;
    }
    return toOptionalString(sentry.spanToJSON(span).trace_id);
  } catch {
    return undefined;
  }
}

export function resolveErrorReference(eventId?: string): ErrorReference | null {
  const traceId = getActiveTraceId();
  if (!eventId && !traceId) {
    return null;
  }

  if (!traceId) {
    return null;
  }

  return {
    traceId,
    ...(eventId ? { eventId } : {})
  };
}
