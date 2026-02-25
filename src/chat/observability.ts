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
    ...(context as Record<string, unknown>),
    ...attributes
  };
}

export function captureException(error: unknown, context: ObservabilityContext = {}): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception("exception_captured", normalizedError, context as Record<string, unknown>, "Captured exception");
}

function logWithLevel(
  level: "info" | "warn" | "error",
  message: string,
  attributes: Record<string, unknown> = {}
): void {
  if (level === "info") {
    log.info(message, attributes, message);
    return;
  }
  if (level === "warn") {
    log.warn(message, attributes, message);
    return;
  }
  log.error(message, attributes, message);
}

export function logInfo(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("info", message, toContextAndAttributes(context, attributes));
}

export function logWarn(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("warn", message, toContextAndAttributes(context, attributes));
}

export function logError(message: string, context: ObservabilityContext = {}, attributes: Record<string, unknown> = {}): void {
  logWithLevel("error", message, toContextAndAttributes(context, attributes));
}

export function logException(
  error: unknown,
  message: string,
  context: ObservabilityContext = {},
  attributes: Record<string, unknown> = {}
): void {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception(message, normalizedError, toContextAndAttributes(context, attributes), message);
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
  callback: () => Promise<T>
): Promise<T> {
  return withLogContext(context, () =>
    Sentry.startSpan(
      {
        name,
        op,
        attributes: toSpanAttributes(context)
      },
      callback
    )
  );
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
