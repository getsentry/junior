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
): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception(eventName, normalizedError, toContextAndAttributes(context, attributes), body);
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
  const normalizedAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      normalizedAttributes[key] = value;
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

  const setAttribute = (span as { setAttribute?: (key: string, value: string | number | boolean) => void }).setAttribute;
  if (typeof setAttribute !== "function") {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      setAttribute.call(span, key, value);
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
  Sentry.withScope((scope) => {
    setSentryScopeContext(scope, context);
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(normalizedError);
  });
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
