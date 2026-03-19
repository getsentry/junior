import { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/nextjs";

type Primitive = string | number | boolean;
type AttributeValue = Primitive | string[];
export type LogAttributes = Record<string, AttributeValue>;
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface EmittedLogRecord {
  attributes: LogAttributes;
  body: string;
  eventName: string;
  level: LogLevel;
}

export interface LogContext {
  conversationId?: string;
  turnId?: string;
  agentId?: string;
  platform?: string;
  requestId?: string;
  slackThreadId?: string;
  slackUserId?: string;
  slackUserName?: string;
  slackChannelId?: string;
  runId?: string;
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
];

const LEGACY_KEY_MAP: Record<string, string> = {
  error: "error.message",
  "error.stack": "exception.stacktrace",
  "gen_ai.system": "gen_ai.provider.name",
  "gen_ai.request.messages": "gen_ai.input.messages",
  "gen_ai.response.text": "gen_ai.output.messages",
  "messaging.conversation.id": "messaging.message.conversation_id",
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
  inferredScore: "app.skill.score",
};

const contextStorage = new AsyncLocalStorage<LogAttributes>();
const logRecordSinks = new Set<(record: EmittedLogRecord) => void>();
const ANSI = {
  reset: "\u001b[0m",
  faint: "\u001b[2m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;
const CONSOLE_PRIORITY_KEYS = [
  "app.conversation.id",
  "app.turn.id",
  "event.name",
  "error.message",
  "messaging.message.id",
  "app.trace_id",
  "app.span_id",
  "app.agent.id",
  "messaging.message.conversation_id",
  "messaging.destination.name",
  "app.run.id",
  "app.message.kind",
] as const;
const CONSOLE_PRIORITY_INDEX: Map<string, number> = new Map(
  CONSOLE_PRIORITY_KEYS.map((key, index) => [key, index]),
);
const CONSOLE_ALWAYS_HIDDEN_KEYS = new Set([
  "app.assistant.username",
  "app.platform",
  "enduser.id",
  "enduser.pseudo_id",
  "http.request.method",
  "messaging.system",
  "url.full",
  "url.path",
  "user_agent.original",
]);
const CONSOLE_DROP_WHEN_COUNTED_KEYS = new Set([
  "app.capability.names",
  "app.capability.providers",
  "app.config.keys",
]);
const CONSOLE_PREVIEW_KEYS = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

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

function shouldSuppressInfoLog(_level: LogLevel): boolean {
  return false;
}

function shouldEmitConsole(level: LogLevel): boolean {
  if (process.env.NODE_ENV === "test") {
    return level === "error";
  }

  return getSentryEnvironment() !== "production";
}

function findNextBlankLineBoundary(
  input: string,
  start: number,
): { start: number; end: number } | null {
  const lfBoundary = input.indexOf("\n\n", start);
  const crlfBoundary = input.indexOf("\r\n\r\n", start);

  if (lfBoundary === -1 && crlfBoundary === -1) {
    return null;
  }
  if (lfBoundary === -1) {
    return { start: crlfBoundary, end: crlfBoundary + 4 };
  }
  if (crlfBoundary === -1 || lfBoundary < crlfBoundary) {
    return { start: lfBoundary, end: lfBoundary + 2 };
  }
  return { start: crlfBoundary, end: crlfBoundary + 4 };
}

function redactPrivateKeyBlocks(input: string): string {
  const beginPrefix = "-----BEGIN ";
  const footerMarker = "-----";
  let cursor = 0;
  let output = "";

  while (cursor < input.length) {
    const begin = input.indexOf(beginPrefix, cursor);
    if (begin === -1) {
      output += input.slice(cursor);
      break;
    }

    const labelStart = begin + beginPrefix.length;
    const labelEnd = input.indexOf(footerMarker, labelStart);
    if (labelEnd === -1) {
      output += input.slice(cursor);
      break;
    }

    const label = input.slice(labelStart, labelEnd);
    if (!label.endsWith("PRIVATE KEY")) {
      output += input.slice(cursor, labelEnd + footerMarker.length);
      cursor = labelEnd + footerMarker.length;
      continue;
    }

    const header = input.slice(begin, labelEnd + footerMarker.length);
    const footer = `-----END ${label}-----`;
    const footerStart = input.indexOf(footer, labelEnd + footerMarker.length);
    if (footerStart === -1) {
      const resumeBoundary = findNextBlankLineBoundary(
        input,
        labelEnd + footerMarker.length,
      );
      output += input.slice(cursor, begin);
      output += `${header}\n...redacted...`;
      if (!resumeBoundary) {
        break;
      }
      output += input.slice(resumeBoundary.start, resumeBoundary.end);
      cursor = resumeBoundary.end;
      continue;
    }

    output += input.slice(cursor, begin);
    output += `${header}\n...redacted...\n${footer}`;
    cursor = footerStart + footer.length;
  }

  return output;
}

function redactSecrets(input: string): string {
  let out = redactPrivateKeyBlocks(input);
  for (const pattern of SECRETS_RE) {
    out = out.replace(pattern, (full, token: string) => {
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
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_][a-z0-9_-]*)+$/.test(key);
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

function sanitizePrimitive(value: unknown): Primitive | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const redacted = redactSecrets(trimmed);
    return redacted.length > MAX_STRING_VALUE
      ? `${redacted.slice(0, MAX_STRING_VALUE)}...`
      : redacted;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Error) {
    return redactSecrets(value.message);
  }

  try {
    const json = JSON.stringify(value);
    if (!json) return undefined;
    const redacted = redactSecrets(json);
    return redacted.length > MAX_STRING_VALUE
      ? `${redacted.slice(0, MAX_STRING_VALUE)}...`
      : redacted;
  } catch {
    return undefined;
  }
}

function sanitizeValue(value: unknown): AttributeValue | undefined {
  if (Array.isArray(value)) {
    const sanitized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => sanitizePrimitive(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return sanitized.length > 0 ? sanitized : undefined;
  }
  return sanitizePrimitive(value);
}

function contextToAttributes(context: LogContext): LogAttributes {
  const attributes: Record<string, unknown> = {
    "app.conversation.id": context.conversationId,
    "app.turn.id": context.turnId,
    "app.agent.id": context.agentId,
    "app.platform": context.platform,
    "app.request.id": context.requestId,
    "messaging.system":
      context.platform === "slack" ? "slack" : context.platform,
    "messaging.message.conversation_id": context.slackThreadId,
    "messaging.destination.name": context.slackChannelId,
    "enduser.id": context.slackUserId,
    "enduser.pseudo_id": context.slackUserName,
    "app.run.id": context.runId,
    "app.assistant.username": context.assistantUserName,
    "gen_ai.request.model": context.modelId,
    "app.skill.name": context.skillName,
    "http.request.method": context.httpMethod,
    "url.path": context.httpPath,
    "url.full": context.urlFull,
    "user_agent.original": context.userAgent,
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
  if (
    typeof sentry.getActiveSpan !== "function" ||
    typeof sentry.spanToJSON !== "function"
  ) {
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

function mergeAttributes(
  ...maps: Array<Record<string, unknown> | undefined>
): LogAttributes {
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

function emitSentry(
  level: LogLevel,
  body: string,
  attributes: LogAttributes,
): void {
  if (shouldSuppressInfoLog(level)) {
    return;
  }

  const sentry = Sentry as unknown as SentryLike;
  const loggerFn = sentry.logger?.[level];
  if (typeof loggerFn === "function") {
    loggerFn(body, attributes);
    return;
  }

  const sentryWithScope = (
    sentry as unknown as {
      withScope?: (callback: (scope: Sentry.Scope) => void) => void;
    }
  ).withScope;
  const sentryCaptureMessage = (
    sentry as unknown as {
      captureMessage?: (
        message: string,
        level?: "debug" | "info" | "warning" | "error",
      ) => void;
    }
  ).captureMessage;
  const sentryLevel = level === "warn" ? "warning" : level;

  if (
    typeof sentryWithScope === "function" &&
    typeof sentryCaptureMessage === "function"
  ) {
    sentryWithScope((scope) => {
      for (const [key, value] of Object.entries(attributes)) {
        scope.setExtra(key, value);
      }
      sentryCaptureMessage(body, sentryLevel);
    });
    return;
  }

  if (typeof sentryCaptureMessage === "function") {
    sentryCaptureMessage(body, sentryLevel);
  }
}

function formatConsoleLevel(level: LogLevel): "DBG" | "INF" | "WRN" | "ERR" {
  if (level === "debug") return "DBG";
  if (level === "info") return "INF";
  if (level === "warn") return "WRN";
  return "ERR";
}

function consoleLevelColor(level: LogLevel): string {
  if (level === "error") return ANSI.red;
  if (level === "warn") return ANSI.yellow;
  if (level === "info") return ANSI.green;
  return ANSI.blue;
}

function quoteConsoleValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatConsoleValue(value: AttributeValue): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return quoteConsoleValue(JSON.stringify(value));
  }

  // Bare values stay readable; everything else is safely quoted.
  if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) {
    return value;
  }
  return quoteConsoleValue(value);
}

function shouldShowConsoleDestinationName(eventName: string): boolean {
  return /^(app_home_|oauth_|queue_|slash_command_|slack_|webhook_)/.test(
    eventName,
  );
}

function shouldShowConsoleModel(level: LogLevel, eventName: string): boolean {
  if (level === "warn" || level === "error") {
    return true;
  }

  return (
    eventName.startsWith("ai_") ||
    eventName.startsWith("assistant_") ||
    eventName === "agent_turn_started" ||
    eventName === "agent_turn_completed" ||
    eventName === "agent_turn_provider_error"
  );
}

function shouldHideConsoleAttribute(
  level: LogLevel,
  eventName: string,
  key: string,
  attributes: LogAttributes,
): boolean {
  if (CONSOLE_ALWAYS_HIDDEN_KEYS.has(key)) {
    return true;
  }
  if (CONSOLE_DROP_WHEN_COUNTED_KEYS.has(key)) {
    return true;
  }
  if (key === "app.agent.id" && attributes[key] === attributes["app.turn.id"]) {
    return true;
  }
  if (
    key === "messaging.message.conversation_id" &&
    attributes[key] === attributes["app.conversation.id"]
  ) {
    return true;
  }
  if (
    key === "app.message.id" &&
    attributes[key] === attributes["messaging.message.id"]
  ) {
    return true;
  }
  if (
    key === "messaging.destination.name" &&
    !shouldShowConsoleDestinationName(eventName)
  ) {
    return true;
  }
  if (
    key === "gen_ai.request.model" &&
    !shouldShowConsoleModel(level, eventName)
  ) {
    return true;
  }
  if (
    key === "gen_ai.provider.name" &&
    eventName.startsWith("agent_tool_call_") &&
    level !== "warn" &&
    level !== "error"
  ) {
    return true;
  }
  if (
    key === "gen_ai.operation.name" &&
    eventName.startsWith("agent_tool_call_")
  ) {
    return true;
  }

  return false;
}

function summarizeConsoleString(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}... [${collapsed.length} chars]`;
}

function projectConsoleValue(
  level: LogLevel,
  key: string,
  value: AttributeValue,
): AttributeValue | undefined {
  if (
    (level === "debug" || level === "info") &&
    CONSOLE_PREVIEW_KEYS.has(key) &&
    typeof value === "string"
  ) {
    return summarizeConsoleString(
      value,
      key === "gen_ai.tool.call.result" ? 220 : 140,
    );
  }

  return value;
}

function projectConsoleAttributes(
  level: LogLevel,
  eventName: string,
  attributes: LogAttributes,
): LogAttributes {
  const projected: LogAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (shouldHideConsoleAttribute(level, eventName, key, attributes)) {
      continue;
    }

    const nextValue = projectConsoleValue(level, key, value);
    if (nextValue !== undefined) {
      projected[key] = nextValue;
    }
  }

  return projected;
}

function formatConsoleLine(
  level: LogLevel,
  eventName: string,
  body: string,
  attributes: LogAttributes,
): string {
  const timestamp = new Date().toISOString();
  const useColor =
    process.env.NODE_ENV === "development" && Boolean(process.stdout?.isTTY);
  const levelColor = consoleLevelColor(level);
  const colorize = (text: string, color: string) =>
    useColor ? `${color}${text}${ANSI.reset}` : text;

  const parts = [
    `${colorize(timestamp, ANSI.gray)} ${colorize(formatConsoleLevel(level), levelColor)} ${body}`,
  ];
  const projectedAttributes = projectConsoleAttributes(
    level,
    eventName,
    attributes,
  );
  const sortedAttributes = Object.entries(projectedAttributes).sort(
    ([left], [right]) => {
      const leftRank = CONSOLE_PRIORITY_INDEX.get(left);
      const rightRank = CONSOLE_PRIORITY_INDEX.get(right);
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
      }
      return left.localeCompare(right);
    },
  );
  for (const [key, value] of sortedAttributes) {
    const rendered = `${colorize(key, ANSI.cyan)}=${colorize(formatConsoleValue(value), ANSI.faint)}`;
    parts.push(rendered);
  }
  return parts.join(" ");
}

function emitConsole(
  level: LogLevel,
  eventName: string,
  body: string,
  attributes: LogAttributes,
): void {
  if (!shouldEmitConsole(level)) {
    return;
  }

  const line = formatConsoleLine(level, eventName, body, attributes);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "info") {
    console.info(line);
    return;
  }
  console.debug(line);
}

function emit(
  level: LogLevel,
  eventName: string,
  attrs: Record<string, unknown> = {},
  body?: string,
): void {
  const contextAttributes = contextStorage.getStore() ?? {};
  const traceAttributes = getTraceCorrelationAttributes();
  const normalizedEventName = toSnakeCase(eventName);
  const message = body ? redactSecrets(body) : normalizedEventName;
  const attributes = mergeAttributes(contextAttributes, traceAttributes, {
    "event.name": normalizedEventName,
    ...attrs,
  });

  for (const sink of logRecordSinks) {
    try {
      sink({
        level,
        eventName: normalizedEventName,
        body: message,
        attributes,
      });
    } catch {
      // Test-only sink failures must not break runtime logging.
    }
  }

  emitConsole(level, normalizedEventName, message, attributes);
  emitSentry(level, message, attributes);
}

export const log = {
  debug(
    eventName: string,
    attrs: Record<string, unknown> = {},
    body?: string,
  ): void {
    emit("debug", eventName, attrs, body);
  },
  info(
    eventName: string,
    attrs: Record<string, unknown> = {},
    body?: string,
  ): void {
    emit("info", eventName, attrs, body);
  },
  warn(
    eventName: string,
    attrs: Record<string, unknown> = {},
    body?: string,
  ): void {
    emit("warn", eventName, attrs, body);
  },
  error(
    eventName: string,
    attrs: Record<string, unknown> = {},
    body?: string,
  ): void {
    emit("error", eventName, attrs, body);
  },
  exception(
    eventName: string,
    error: unknown,
    attrs: Record<string, unknown> = {},
    body?: string,
  ): string | undefined {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    emit(
      "error",
      eventName,
      {
        ...attrs,
        "error.type": normalizedError.name,
        "error.message": normalizedError.message,
        "exception.type": normalizedError.name,
        "exception.message": normalizedError.message,
        "exception.stacktrace": normalizedError.stack,
      },
      body ?? normalizedError.message,
    );

    let eventId: string | undefined;
    const sentryWithScope = (
      Sentry as unknown as {
        withScope?: (callback: (scope: Sentry.Scope) => void) => void;
      }
    ).withScope;
    const sentryCaptureException = (
      Sentry as unknown as {
        captureException?: (error: unknown) => string | undefined;
      }
    ).captureException;

    if (
      typeof sentryWithScope === "function" &&
      typeof sentryCaptureException === "function"
    ) {
      sentryWithScope((scope) => {
        for (const [key, value] of Object.entries(
          mergeAttributes(contextStorage.getStore(), attrs),
        )) {
          scope.setExtra(key, value);
        }
        eventId = sentryCaptureException(normalizedError);
      });
      return eventId;
    }

    if (typeof sentryCaptureException === "function") {
      eventId = sentryCaptureException(normalizedError);
    }
    return eventId;
  },
};

export function withLogContext<T>(
  context: LogContext,
  callback: () => Promise<T>,
): Promise<T> {
  const next = mergeAttributes(
    contextStorage.getStore(),
    contextToAttributes(context),
  );
  return contextStorage.run(next, callback);
}

export function setLogContext(context: LogContext): void {
  const merged = mergeAttributes(
    contextStorage.getStore(),
    contextToAttributes(context),
  );
  contextStorage.enterWith(merged);
}

export function getLogContextAttributes(): LogAttributes {
  return contextStorage.getStore() ?? {};
}

export function registerLogRecordSink(
  sink: (record: EmittedLogRecord) => void,
): () => void {
  logRecordSinks.add(sink);
  return () => {
    logRecordSinks.delete(sink);
  };
}

export function createLogContextFromRequest(
  request: Request,
  context: Partial<LogContext> = {},
): LogContext {
  const url = new URL(request.url);
  return {
    ...context,
    requestId:
      context.requestId ?? request.headers.get("x-request-id") ?? undefined,
    httpMethod: request.method,
    httpPath: url.pathname,
    urlFull: url.toString(),
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

export function toSpanAttributes(context: LogContext): Record<string, string> {
  const attrs = contextToAttributes(context);
  return Object.fromEntries(
    Object.entries(attrs).filter(
      ([, value]) => typeof value === "string" && value.length > 0,
    ),
  ) as Record<string, string>;
}

export function setSentryTagsFromContext(context: LogContext): void {
  const attrs = contextToAttributes(context);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.length > 0) {
      Sentry.setTag(key, value);
    }
  }
  if (context.slackUserId) {
    Sentry.setUser({
      id: context.slackUserId,
      username: context.slackUserName,
    });
  }
}

export function setSentryScopeContext(
  scope: Sentry.Scope,
  context: LogContext,
): void {
  const attrs = contextToAttributes(context);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.length > 0) {
      scope.setTag(key, value);
    }
  }
  if (context.slackUserId) {
    scope.setUser({ id: context.slackUserId, username: context.slackUserName });
  }
  scope.setContext("app", attrs);
}
