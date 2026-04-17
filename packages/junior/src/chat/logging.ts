import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { styleText } from "node:util";
import {
  ConfigError,
  configureSync,
  getConfig,
  getLogger,
  type Logger as LogTapeLogger,
  type LogRecord as LogTapeRecord,
  type Sink as LogTapeSink,
} from "@logtape/logtape";
import type {
  Logger as ChatSdkLogger,
  LogLevel as ChatSdkLogLevel,
} from "chat";
import { toOptionalNumber, toOptionalString } from "@/chat/coerce";
import * as Sentry from "@/chat/sentry";

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
  finishReason: "gen_ai.response.finish_reasons",
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
type ConsoleTextStyle = Parameters<typeof styleText>[0];
const LOGTAPE_BODY_KEY = "__logtape_body";
const ROOT_LOGGER_CATEGORY = ["junior"] as const;
const CONSOLE_PRIORITY_KEYS = [
  "gen_ai.conversation.id",
  "app.turn.id",
  "event.name",
  "app.log.source",
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
  "gen_ai.agent.name",
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
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    ""
  )
    .trim()
    .toLowerCase();
}

function shouldSuppressInfoLog(level: LogLevel): boolean {
  return getSentryEnvironment() === "production" && level === "info";
}

function shouldEmitConsole(level: LogLevel): boolean {
  if (process.env.NODE_ENV === "test") {
    return level === "error";
  }

  return true;
}

function isDevelopmentLoggingMode(): boolean {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }
  if (process.env.CI) {
    return false;
  }
  return true;
}

function shouldUseDevelopmentConsoleFormat(): boolean {
  if (!isDevelopmentLoggingMode()) {
    return false;
  }
  return process.env.JUNIOR_LOG_FORMAT?.trim().toLowerCase() !== "structured";
}

function shouldUsePrettyConsole(level: LogLevel): boolean {
  if (level === "warn" || level === "error") {
    return false;
  }
  return shouldUseDevelopmentConsoleFormat();
}

function shouldUseConsoleColor(): boolean {
  if (!shouldUseDevelopmentConsoleFormat()) {
    return false;
  }
  if (process.env.NO_COLOR) {
    return false;
  }
  return (
    process.env.FORCE_COLOR?.trim() === "1" ||
    Boolean(process.stdout?.isTTY) ||
    Boolean(process.stderr?.isTTY)
  );
}

function formatConsoleTimestamp(timestamp: Date): string {
  if (shouldUseDevelopmentConsoleFormat()) {
    return timestamp.toTimeString().slice(0, 8);
  }
  return timestamp.toISOString();
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
    "gen_ai.conversation.id": context.conversationId,
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
    "gen_ai.agent.name": context.assistantUserName,
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
      const value = sanitizeValue(
        key === "gen_ai.response.finish_reasons" &&
          typeof rawValue === "string" &&
          rawValue.trim()
          ? [rawValue]
          : rawValue,
      );
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function fromLogTapeLevel(level: LogTapeRecord["level"]): LogLevel {
  if (level === "warning") {
    return "warn";
  }
  if (level === "fatal") {
    return "error";
  }
  if (level === "trace") {
    return "debug";
  }
  return level;
}

function getLogSource(category: readonly string[]): string | undefined {
  if (category.length <= ROOT_LOGGER_CATEGORY.length) {
    return undefined;
  }

  const sourceParts = category.slice(ROOT_LOGGER_CATEGORY.length);
  return sourceParts.length > 0 ? sourceParts.join(".") : undefined;
}

function toEmittedLogRecord(record: LogTapeRecord): EmittedLogRecord {
  const properties = { ...record.properties };
  const rawBody = properties[LOGTAPE_BODY_KEY];
  delete properties[LOGTAPE_BODY_KEY];

  const attributes = mergeAttributes(properties);
  const source = getLogSource(record.category);
  if (source && attributes["app.log.source"] === undefined) {
    attributes["app.log.source"] = source;
  }

  const body =
    toOptionalString(rawBody) ??
    record.message
      .map((segment) =>
        typeof segment === "string" ? segment : String(segment ?? ""),
      )
      .join("");
  const eventName =
    toOptionalString(attributes["event.name"]) ?? "log_record_emitted";

  return {
    level: fromLogTapeLevel(record.level),
    eventName,
    body,
    attributes,
  };
}

function createConsoleSink(): LogTapeSink {
  return (record) => {
    const emitted = toEmittedLogRecord(record);
    emitConsole(
      emitted.level,
      emitted.eventName,
      emitted.body,
      emitted.attributes,
    );
  };
}

function createSentrySink(): LogTapeSink {
  return (record) => {
    const emitted = toEmittedLogRecord(record);
    emitSentry(emitted.level, emitted.body, emitted.attributes);
  };
}

function createRecordSink(): LogTapeSink {
  return (record) => {
    const emitted = toEmittedLogRecord(record);
    for (const sink of logRecordSinks) {
      try {
        sink(emitted);
      } catch {
        // Test-only sink failures must not break runtime logging.
      }
    }
  };
}

let rootLogger: LogTapeLogger | undefined;
let ownsLogTapeBackend = false;
let usesDirectEmissionFallback = false;

function ensureLoggerBackend(): void {
  if (rootLogger || usesDirectEmissionFallback) {
    return;
  }

  if (getConfig() !== null) {
    usesDirectEmissionFallback = true;
    return;
  }

  try {
    configureSync({
      sinks: {
        console: createConsoleSink(),
        sentry: createSentrySink(),
        records: createRecordSink(),
      },
      loggers: [
        {
          category: [...ROOT_LOGGER_CATEGORY],
          sinks: ["console", "sentry", "records"],
          lowestLevel: "debug",
        },
        {
          category: ["logtape"],
          sinks: ["console"],
          lowestLevel: "error",
        },
      ],
      contextLocalStorage: contextStorage,
    });
    ownsLogTapeBackend = true;
    rootLogger = getLogger([...ROOT_LOGGER_CATEGORY]);
  } catch (error) {
    if (error instanceof ConfigError && getConfig() !== null) {
      usesDirectEmissionFallback = true;
      return;
    }
    throw error;
  }
}

function getLogTapeLogger(category: readonly string[] = []): LogTapeLogger {
  ensureLoggerBackend();
  if (!rootLogger) {
    throw new Error("LogTape backend is unavailable");
  }

  let logger = rootLogger as LogTapeLogger;
  for (const part of category) {
    logger = logger.getChild(part);
  }
  return logger;
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

function consoleLevelStyle(level: LogLevel): ConsoleTextStyle {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (level === "info") return "green";
  return "blue";
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
    attributes[key] === attributes["gen_ai.conversation.id"]
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

function abbreviateConsoleId(value: string): string {
  if (value.length <= 20) {
    return value;
  }
  return `${value.slice(0, 12)}...${value.slice(-4)}`;
}

function toRelativeConsolePath(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return normalized;
  }

  try {
    const relative = path.relative(process.cwd(), normalized);
    if (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    ) {
      return relative;
    }
  } catch {
    // Ignore path projection failures and keep the original value.
  }

  return normalized;
}

function pushPrettyConsoleToken(
  tokens: string[],
  token: string | undefined,
): void {
  if (!token || tokens.includes(token)) {
    return;
  }
  tokens.push(token);
}

function numericConsoleToken(
  label: string,
  value: AttributeValue | undefined,
): string | undefined {
  return typeof value === "number" ? `${label}=${value}` : undefined;
}

function booleanConsoleToken(
  label: string,
  value: AttributeValue | undefined,
): string | undefined {
  return typeof value === "boolean"
    ? `${label}=${value ? "yes" : "no"}`
    : undefined;
}

function shouldShowPrettyCorrelation(eventName: string): boolean {
  return !(
    eventName === "plugin_loaded" ||
    eventName === "startup_discovery_summary" ||
    eventName === "capability_catalog_loaded" ||
    eventName.endsWith("_loaded")
  );
}

function getPrettyConsoleSummaryTokens(
  level: LogLevel,
  eventName: string,
  attributes: LogAttributes,
): string[] {
  const tokens: string[] = [];
  pushPrettyConsoleToken(
    tokens,
    toOptionalString(attributes["app.log.source"]) ?? undefined,
  );
  pushPrettyConsoleToken(
    tokens,
    toOptionalString(attributes["app.plugin.name"]) ?? undefined,
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("caps", attributes["app.plugin.capability_count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("config", attributes["app.plugin.config_key_count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    booleanConsoleToken("mcp", attributes["app.plugin.has_mcp"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("plugins", attributes["app.plugin.count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("skills", attributes["app.skill.count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("capabilities", attributes["app.capability.count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("config", attributes["app.config.key_count"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken("chars", attributes["app.message.length"]),
  );
  pushPrettyConsoleToken(
    tokens,
    numericConsoleToken(
      "attachments",
      attributes["app.message.attachment_count"],
    ),
  );
  const rawAttachmentCount = toOptionalNumber(
    attributes["app.message.attachment_count"],
  );
  const promptAttachmentCount = toOptionalNumber(
    attributes["app.message.prompt_attachment_count"],
  );
  if (
    promptAttachmentCount !== undefined &&
    promptAttachmentCount !== rawAttachmentCount
  ) {
    pushPrettyConsoleToken(
      tokens,
      numericConsoleToken("prompt_attachments", promptAttachmentCount),
    );
  }

  const filePath = toOptionalString(attributes["file.path"]);
  if (filePath && eventName.endsWith("_loaded")) {
    pushPrettyConsoleToken(tokens, toRelativeConsolePath(filePath));
  }

  if (shouldShowPrettyCorrelation(eventName)) {
    const conversationId = toOptionalString(
      attributes["gen_ai.conversation.id"],
    );
    const turnId = toOptionalString(attributes["app.turn.id"]);
    const messageId = toOptionalString(attributes["messaging.message.id"]);
    if (conversationId) {
      pushPrettyConsoleToken(
        tokens,
        `conv=${abbreviateConsoleId(conversationId)}`,
      );
    }
    if (turnId) {
      pushPrettyConsoleToken(tokens, `turn=${abbreviateConsoleId(turnId)}`);
    }
    if (messageId) {
      pushPrettyConsoleToken(tokens, `msg=${abbreviateConsoleId(messageId)}`);
    }
  }

  const model = toOptionalString(attributes["gen_ai.request.model"]);
  if (model && shouldShowConsoleModel(level, eventName)) {
    pushPrettyConsoleToken(tokens, `model=${model}`);
  }

  return tokens;
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
  const timestamp = new Date();
  const useColor = shouldUseConsoleColor();
  const levelStyle = consoleLevelStyle(level);
  const colorize = (text: string, style: ConsoleTextStyle) =>
    useColor ? styleText(style, text) : text;

  if (shouldUsePrettyConsole(level)) {
    const summaryTokens = getPrettyConsoleSummaryTokens(
      level,
      eventName,
      attributes,
    );
    const summary = [body, ...summaryTokens].join(" ");
    return [
      colorize(formatConsoleTimestamp(timestamp), "gray"),
      colorize(formatConsoleLevel(level), levelStyle),
      summary,
    ].join(" ");
  }

  const parts = [
    `${colorize(formatConsoleTimestamp(timestamp), "gray")} ${colorize(formatConsoleLevel(level), levelStyle)} ${body}`,
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
    const rendered = `${colorize(key, "cyan")}=${colorize(formatConsoleValue(value), "dim")}`;
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

function emitDirect(
  level: LogLevel,
  eventName: string,
  body: string,
  attributes: LogAttributes,
): void {
  for (const sink of logRecordSinks) {
    try {
      sink({
        level,
        eventName,
        body,
        attributes,
      });
    } catch {
      // Test-only sink failures must not break runtime logging.
    }
  }

  emitConsole(level, eventName, body, attributes);
  emitSentry(level, body, attributes);
}

function emitRecord(
  category: readonly string[],
  level: LogLevel,
  eventName: string,
  attrs: Record<string, unknown> = {},
  body?: string,
): void {
  ensureLoggerBackend();
  const traceAttributes = getTraceCorrelationAttributes();
  const normalizedEventName = toSnakeCase(eventName);
  const message = body ? redactSecrets(body) : normalizedEventName;
  const source = getLogSource([...ROOT_LOGGER_CATEGORY, ...category]);
  const contextAttributes = ownsLogTapeBackend
    ? undefined
    : contextStorage.getStore();
  const attributes = mergeAttributes(contextAttributes, traceAttributes, {
    "event.name": normalizedEventName,
    ...(source ? { "app.log.source": source } : {}),
    ...attrs,
  });

  if (usesDirectEmissionFallback) {
    emitDirect(level, normalizedEventName, message, attributes);
    return;
  }

  const logger = getLogTapeLogger(category);
  const properties: Record<string, unknown> = {
    [LOGTAPE_BODY_KEY]: message,
    ...attributes,
  };

  if (level === "error") {
    logger.error(`{${LOGTAPE_BODY_KEY}}`, properties);
    return;
  }
  if (level === "warn") {
    logger.warn(`{${LOGTAPE_BODY_KEY}}`, properties);
    return;
  }
  if (level === "info") {
    logger.info(`{${LOGTAPE_BODY_KEY}}`, properties);
    return;
  }
  logger.debug(`{${LOGTAPE_BODY_KEY}}`, properties);
}

function emit(
  level: LogLevel,
  eventName: string,
  attrs: Record<string, unknown> = {},
  body?: string,
): void {
  emitRecord([], level, eventName, attrs, body);
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

const CHAT_SDK_LEVEL_PRIORITY: Record<
  Exclude<ChatSdkLogLevel, "silent">,
  number
> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveChatSdkLogLevel(): ChatSdkLogLevel {
  if (isDevelopmentLoggingMode()) {
    return "warn";
  }

  return "info";
}

function shouldEmitChatSdkLevel(
  level: Exclude<ChatSdkLogLevel, "silent">,
  minimumLevel: ChatSdkLogLevel,
): boolean {
  if (minimumLevel === "silent") {
    return false;
  }

  return (
    CHAT_SDK_LEVEL_PRIORITY[level] >= CHAT_SDK_LEVEL_PRIORITY[minimumLevel]
  );
}

function renderChatSdkArgument(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatChatSdkBody(message: string, args: unknown[]): string {
  const renderedArgs = args
    .map((arg) => renderChatSdkArgument(arg).trim())
    .filter((arg) => arg.length > 0);
  if (renderedArgs.length === 0) {
    return message;
  }
  return `${message} ${renderedArgs.join(" ")}`;
}

function createChatSdkLoggerImpl(
  category: readonly string[],
  minimumLevel: ChatSdkLogLevel,
): ChatSdkLogger {
  const emitChatSdkLog = (
    level: Exclude<ChatSdkLogLevel, "silent">,
    message: string,
    args: unknown[],
  ): void => {
    if (!shouldEmitChatSdkLevel(level, minimumLevel)) {
      return;
    }

    emitRecord(
      category,
      level === "warn" ? "warn" : level,
      level === "error"
        ? "chat_sdk_error"
        : level === "warn"
          ? "chat_sdk_warning"
          : "chat_sdk_log",
      args.length > 0
        ? {
            "app.log.args": args.length === 1 ? args[0] : args,
          }
        : {},
      formatChatSdkBody(message, args),
    );
  };

  return {
    child(prefix: string): ChatSdkLogger {
      return createChatSdkLoggerImpl([...category, prefix], minimumLevel);
    },
    debug(message: string, ...args: unknown[]): void {
      emitChatSdkLog("debug", message, args);
    },
    info(message: string, ...args: unknown[]): void {
      emitChatSdkLog("info", message, args);
    },
    warn(message: string, ...args: unknown[]): void {
      emitChatSdkLog("warn", message, args);
    },
    error(message: string, ...args: unknown[]): void {
      emitChatSdkLog("error", message, args);
    },
  };
}

/** Create a Chat SDK logger that routes records through Junior's logging backend. */
export function createChatSdkLogger(): ChatSdkLogger {
  return createChatSdkLoggerImpl(["chat-sdk"], resolveChatSdkLogLevel());
}

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

// ---------------------------------------------------------------------------
// High-level observability API (spans, error capture, convenience loggers)
// ---------------------------------------------------------------------------

export interface ErrorReference {
  traceId: string;
  eventId?: string;
}

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | string[];

function toSpanAttributeValue(value: unknown): SpanAttributeValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const sanitized = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return sanitized.length > 0 ? sanitized : undefined;
}

/** Capture an error to Sentry and emit an error log record. */
export function captureException(
  error: unknown,
  context: LogContext = {},
): void {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));
  log.exception(
    "exception_captured",
    normalizedError,
    toSpanAttributes(context),
    "Captured exception",
  );
}

/** Log an info-level structured event. */
export function logInfo(
  eventName: string,
  context: LogContext = {},
  attributes: Record<string, unknown> = {},
  body?: string,
): void {
  log.info(eventName, { ...toSpanAttributes(context), ...attributes }, body);
}

/** Log a warning-level structured event. */
export function logWarn(
  eventName: string,
  context: LogContext = {},
  attributes: Record<string, unknown> = {},
  body?: string,
): void {
  log.warn(eventName, { ...toSpanAttributes(context), ...attributes }, body);
}

/** Log an error-level structured event. */
export function logError(
  eventName: string,
  context: LogContext = {},
  attributes: Record<string, unknown> = {},
  body?: string,
): void {
  log.error(eventName, { ...toSpanAttributes(context), ...attributes }, body);
}

/** Log an error with exception capture; returns the Sentry event ID if available. */
export function logException(
  error: unknown,
  eventName: string,
  context: LogContext = {},
  attributes: Record<string, unknown> = {},
  body?: string,
): string | undefined {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));
  return log.exception(
    eventName,
    normalizedError,
    { ...toSpanAttributes(context), ...attributes },
    body,
  );
}

/** Set log context and Sentry tags for the current scope. */
export function setTags(context: LogContext = {}): void {
  setLogContext(context);
  setSentryTagsFromContext(context);
}

/** Create a LogContext from an incoming HTTP request. */
export function createRequestContext(
  request: Request,
  context: Partial<LogContext> = {},
): LogContext {
  return createLogContextFromRequest(request, context);
}

/** Run a callback within a scoped log context. */
export async function withContext<T>(
  context: LogContext,
  callback: () => Promise<T>,
): Promise<T> {
  return withLogContext(context, callback);
}

/** Run a callback within a Sentry span and scoped log context. */
export async function withSpan<T>(
  name: string,
  op: string,
  context: LogContext,
  callback: () => Promise<T>,
  attributes: Record<string, unknown> = {},
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
          ...normalizedAttributes,
        },
      },
      callback,
    ),
  );
}

/** Set attributes on the currently active Sentry span. */
export function setSpanAttributes(attributes: Record<string, unknown>): void {
  const sentry = Sentry as unknown as { getActiveSpan?: () => unknown };
  const span = sentry.getActiveSpan?.();
  if (!span) {
    return;
  }

  const setAttribute = (
    span as { setAttribute?: (key: string, value: SpanAttributeValue) => void }
  ).setAttribute;
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

/** Set the status of the currently active Sentry span. */
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

/** Capture an exception within an isolated Sentry scope. */
export function captureExceptionInScope(
  error: unknown,
  context: LogContext = {},
): void {
  const sentryWithScope = (
    Sentry as unknown as {
      withScope?: (callback: (scope: Sentry.Scope) => void) => void;
    }
  ).withScope;
  const sentryCaptureException = (
    Sentry as unknown as {
      captureException?: (error: unknown) => unknown;
    }
  ).captureException;
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  if (
    typeof sentryWithScope === "function" &&
    typeof sentryCaptureException === "function"
  ) {
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

/** Return the trace ID from the active Sentry span, if any. */
export function getActiveTraceId(): string | undefined {
  const sentry = Sentry as unknown as {
    getActiveSpan?: () => unknown;
    spanToJSON?: (span: unknown) => { trace_id?: string };
  };
  if (
    typeof sentry.getActiveSpan !== "function" ||
    typeof sentry.spanToJSON !== "function"
  ) {
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

/** Build a trace + event ID reference for error correlation. */
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
    ...(eventId ? { eventId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Gen-AI attribute serialization
// ---------------------------------------------------------------------------

const GEN_AI_DEFAULT_MAX_ATTRIBUTE_CHARS = 12_000;
const GEN_AI_MAX_STRING_CHARS = 2_000;
const GEN_AI_MAX_ARRAY_ITEMS = 50;
const GEN_AI_MAX_OBJECT_KEYS = 50;

function truncateGenAiString(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function sanitizeGenAiValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  keyName?: string,
): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const shouldTreatAsBlob =
      (keyName === "data" ||
        keyName === "base64" ||
        keyName?.endsWith("_base64") === true) &&
      value.length > 256;
    if (shouldTreatAsBlob) {
      return `[omitted:${value.length}]`;
    }
    return truncateGenAiString(value, GEN_AI_MAX_STRING_CHARS);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (depth >= 8) {
    return "[depth_limit]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, GEN_AI_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeGenAiValue(entry, seen, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record).slice(
    0,
    GEN_AI_MAX_OBJECT_KEYS,
  )) {
    const sanitized = sanitizeGenAiValue(entryValue, seen, depth + 1, key);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }
  return out;
}

/** Serialize an AI model response value into a truncated log attribute. */
export function serializeGenAiAttribute(
  value: unknown,
  maxChars = GEN_AI_DEFAULT_MAX_ATTRIBUTE_CHARS,
): string | undefined {
  const sanitized = sanitizeGenAiValue(value, new WeakSet<object>(), 0);
  if (sanitized === undefined) {
    return undefined;
  }

  const serialized =
    typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  if (!serialized) {
    return undefined;
  }

  return truncateGenAiString(serialized, maxChars);
}

export interface GenAiUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toFiniteTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : undefined;
}

function readTokenCount(
  root: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = toFiniteTokenCount(root[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function collectUsageRoots(source: unknown): Record<string, unknown>[] {
  const sourceRecord = asRecord(source);
  if (!sourceRecord) {
    return [];
  }

  const roots: Record<string, unknown>[] = [sourceRecord];
  const usage = asRecord(sourceRecord.usage);
  if (usage) {
    roots.push(usage);
  }

  const tokenUsage = asRecord(sourceRecord.tokenUsage);
  if (tokenUsage) {
    roots.push(tokenUsage);
  }

  const providerMetadata = asRecord(sourceRecord.providerMetadata);
  if (providerMetadata) {
    roots.push(providerMetadata);
    const providerUsage = asRecord(providerMetadata.usage);
    if (providerUsage) {
      roots.push(providerUsage);
    }
  }

  const response = asRecord(sourceRecord.response);
  if (response) {
    roots.push(response);
    const responseUsage = asRecord(response.usage);
    if (responseUsage) {
      roots.push(responseUsage);
    }
  }

  return roots;
}

/** Extract a structured token-usage summary from provider metadata roots. */
export function extractGenAiUsageSummary(
  ...sources: unknown[]
): GenAiUsageSummary {
  const roots = sources.flatMap((source) => collectUsageRoots(source));
  if (roots.length === 0) {
    return {};
  }

  const inputTokens =
    roots
      .map((root) =>
        readTokenCount(root, [
          "input_tokens",
          "inputTokens",
          "prompt_tokens",
          "promptTokens",
          "inputTokenCount",
          "promptTokenCount",
        ]),
      )
      .find((value) => value !== undefined) ?? undefined;

  const outputTokens =
    roots
      .map((root) =>
        readTokenCount(root, [
          "output_tokens",
          "outputTokens",
          "completion_tokens",
          "completionTokens",
          "outputTokenCount",
          "completionTokenCount",
        ]),
      )
      .find((value) => value !== undefined) ?? undefined;

  const totalTokens =
    roots
      .map((root) =>
        readTokenCount(root, [
          "total_tokens",
          "totalTokens",
          "totalTokenCount",
        ]),
      )
      .find((value) => value !== undefined) ?? undefined;

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** Extract input/output token counts from AI provider usage metadata for tracing. */
export function extractGenAiUsageAttributes(
  ...sources: unknown[]
): Partial<
  Record<"gen_ai.usage.input_tokens" | "gen_ai.usage.output_tokens", number>
> {
  const { inputTokens, outputTokens } = extractGenAiUsageSummary(...sources);

  return {
    ...(inputTokens !== undefined
      ? { "gen_ai.usage.input_tokens": inputTokens }
      : {}),
    ...(outputTokens !== undefined
      ? { "gen_ai.usage.output_tokens": outputTokens }
      : {}),
  };
}
