import { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/nextjs";

type Primitive = string | number | boolean;
export type LogAttributes = Record<string, Primitive>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  platform?: string;
  requestId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackChannelId?: string;
  workflowRunId?: string;
  assistantUserName?: string;
  modelId?: string;
  skillName?: string;
  httpMethod?: string;
  httpPath?: string;
  urlFull?: string;
  userAgent?: string;
}

interface SentryLoggerApi {
  debug?: (message: string, attributes?: Record<string, unknown>) => void;
  info?: (message: string, attributes?: Record<string, unknown>) => void;
  warn?: (message: string, attributes?: Record<string, unknown>) => void;
  error?: (message: string, attributes?: Record<string, unknown>) => void;
}

interface SentryLike {
  logger?: SentryLoggerApi;
  getActiveSpan?: () => unknown;
  spanToJSON?: (span: unknown) => { trace_id?: string; span_id?: string };
}

const MAX_STRING_VALUE = 1200;
const SECRETS_RE = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\bBearer\s+([A-Za-z0-9._\-+=]{20,})\b/gi,
  /\b[A-Z0-9_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*([^\s"']{8,})/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
];

const LEGACY_KEY_MAP: Record<string, string> = {
  error: "error.message",
  bytes: "file.size",
  media_type: "file.mime_type",
  skillDir: "file.path",
  root: "file.directory",
  originalLength: "app.output.original_length",
  parsedLength: "app.output.parsed_length",
  directiveMode: "app.output.directive_mode",
  fileCount: "app.output.file_count",
  attempt: "app.retry.attempt",
  steps: "app.ai.steps",
  toolCalls: "app.ai.tool_calls",
  toolResults: "app.ai.tool_results",
  finishReason: "app.ai.finish_reason",
  sources: "app.ai.sources",
  generatedFiles: "app.ai.generated_files",
  resultFiles: "app.ai.result_files",
  responseMessages: "app.ai.response_messages",
  stepDiagnostics: "app.ai.step_diagnostics",
  inferredSkill: "app.skill.name",
  inferredScore: "app.skill.score"
};

const contextStorage = new AsyncLocalStorage<LogAttributes>();

function getSentryEnvironment(): string {
  return (
    process.env.SENTRY_ENVIRONMENT ??
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    ""
  )
    .trim()
    .toLowerCase();
}

function shouldSuppressInfoLog(level: LogLevel): boolean {
  return level === "info" && getSentryEnvironment() === "production";
}

function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRETS_RE) {
    out = out.replace(pattern, (full, token: string) => {
      if (full.includes("PRIVATE KEY")) {
        const lines = full.trim().split("\n");
        return lines.length >= 2 ? `${lines[0]}\n...redacted...\n${lines[lines.length - 1]}` : "***PRIVATE KEY***";
      }
      if (typeof token !== "string") {
        return "***";
      }
      if (token.length < 12) {
        return full.replace(token, "***");
      }
      return full.replace(token, `${token.slice(0, 4)}...${token.slice(-4)}`);
    });
  }
  return out;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isSemanticKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(key);
}

function normalizeAttributeKey(key: string): string {
  const mapped = LEGACY_KEY_MAP[key];
  if (mapped) {
    return mapped;
  }

  if (isSemanticKey(key)) {
    return key;
  }

  if (key === "platform") return "app.platform";
  if (key === "request.id") return "app.request.id";

  const snake = toSnakeCase(key);
  if (!snake) {
    return "app.attribute";
  }
  return `app.${snake}`;
}

function sanitizeValue(value: unknown): Primitive | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const redacted = redactSecrets(trimmed);
    return redacted.length > MAX_STRING_VALUE ? `${redacted.slice(0, MAX_STRING_VALUE)}...` : redacted;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return `array(${value.length})`;
  }
  if (value instanceof Error) {
    return redactSecrets(value.message);
  }

  try {
    const json = JSON.stringify(value);
    if (!json) return undefined;
    const redacted = redactSecrets(json);
    return redacted.length > MAX_STRING_VALUE ? `${redacted.slice(0, MAX_STRING_VALUE)}...` : redacted;
  } catch {
    return undefined;
  }
}

function contextToAttributes(context: LogContext): LogAttributes {
  const attributes: Record<string, unknown> = {
    "app.platform": context.platform,
    "app.request.id": context.requestId,
    "messaging.system": context.platform === "slack" ? "slack" : context.platform,
    "messaging.conversation.id": context.slackThreadId,
    "messaging.destination.name": context.slackChannelId,
    "enduser.id": context.slackUserId,
    "app.workflow.run_id": context.workflowRunId,
    "app.assistant.username": context.assistantUserName,
    "gen_ai.request.model": context.modelId,
    "app.skill.name": context.skillName,
    "http.request.method": context.httpMethod,
    "url.path": context.httpPath,
    "url.full": context.urlFull,
    "user_agent.original": context.userAgent
  };

  const normalized: LogAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== undefined) normalized[key] = sanitized;
  }
  return normalized;
}

function getTraceCorrelationAttributes(): LogAttributes {
  const sentry = Sentry as unknown as SentryLike;
  if (typeof sentry.getActiveSpan !== "function" || typeof sentry.spanToJSON !== "function") {
    return {};
  }

  try {
    const span = sentry.getActiveSpan();
    if (!span) return {};
    const json = sentry.spanToJSON(span);
    const attrs: LogAttributes = {};
    if (json.trace_id) attrs.trace_id = json.trace_id;
    if (json.span_id) attrs.span_id = json.span_id;
    return attrs;
  } catch {
    return {};
  }
}

function mergeAttributes(...maps: Array<Record<string, unknown> | undefined>): LogAttributes {
  const merged: LogAttributes = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const key = normalizeAttributeKey(rawKey);
      const value = sanitizeValue(rawValue);
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function emitSentry(level: LogLevel, body: string, attributes: LogAttributes): void {
  if (shouldSuppressInfoLog(level)) {
    return;
  }

  const sentry = Sentry as unknown as SentryLike;
  const loggerFn = sentry.logger?.[level];
  if (typeof loggerFn === "function") {
    loggerFn(body, attributes);
    return;
  }

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(attributes)) {
      scope.setExtra(key, value);
    }
    const sentryLevel = level === "warn" ? "warning" : level;
    Sentry.captureMessage(body, sentryLevel);
  });
}

function emit(level: LogLevel, eventName: string, attrs: Record<string, unknown> = {}, body?: string): void {
  const contextAttributes = contextStorage.getStore() ?? {};
  const traceAttributes = getTraceCorrelationAttributes();
  const message = body ? redactSecrets(body) : eventName;
  const attributes = mergeAttributes(
    contextAttributes,
    traceAttributes,
    {
      "event.name": toSnakeCase(eventName),
      ...attrs
    }
  );

  emitSentry(level, message, attributes);
}

export const log = {
  debug(eventName: string, attrs: Record<string, unknown> = {}, body?: string): void {
    emit("debug", eventName, attrs, body);
  },
  info(eventName: string, attrs: Record<string, unknown> = {}, body?: string): void {
    emit("info", eventName, attrs, body);
  },
  warn(eventName: string, attrs: Record<string, unknown> = {}, body?: string): void {
    emit("warn", eventName, attrs, body);
  },
  error(eventName: string, attrs: Record<string, unknown> = {}, body?: string): void {
    emit("error", eventName, attrs, body);
  },
  exception(eventName: string, error: unknown, attrs: Record<string, unknown> = {}, body?: string): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    emit("error", eventName, {
      ...attrs,
      "error.type": normalizedError.name,
      "error.message": normalizedError.message,
      "error.stack": normalizedError.stack
    }, body ?? normalizedError.message);

    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(mergeAttributes(contextStorage.getStore(), attrs))) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(normalizedError);
    });
  }
};

export function withLogContext<T>(context: LogContext, callback: () => Promise<T>): Promise<T> {
  const next = mergeAttributes(contextStorage.getStore(), contextToAttributes(context));
  return contextStorage.run(next, callback);
}

export function setLogContext(context: LogContext): void {
  const merged = mergeAttributes(contextStorage.getStore(), contextToAttributes(context));
  contextStorage.enterWith(merged);
}

export function getLogContextAttributes(): LogAttributes {
  return contextStorage.getStore() ?? {};
}

export function createLogContextFromRequest(request: Request, context: Partial<LogContext> = {}): LogContext {
  const url = new URL(request.url);
  return {
    ...context,
    requestId: context.requestId ?? request.headers.get("x-request-id") ?? undefined,
    httpMethod: request.method,
    httpPath: url.pathname,
    urlFull: url.toString(),
    userAgent: request.headers.get("user-agent") ?? undefined
  };
}

export function toSpanAttributes(context: LogContext): Record<string, string> {
  const attrs = contextToAttributes(context);
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => typeof value === "string" && value.length > 0)
  ) as Record<string, string>;
}

export function setSentryTagsFromContext(context: LogContext): void {
  const attrs = contextToAttributes(context);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.length > 0) {
      Sentry.setTag(key, value);
    }
  }
}

export function setSentryScopeContext(scope: Sentry.Scope, context: LogContext): void {
  const attrs = contextToAttributes(context);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.length > 0) {
      scope.setTag(key, value);
    }
  }
  scope.setContext("app", attrs);
}
