// src/chat/observability.ts
import * as Sentry2 from "@sentry/nextjs";

// src/chat/logging.ts
import { AsyncLocalStorage } from "async_hooks";
import * as Sentry from "@sentry/nextjs";
var MAX_STRING_VALUE = 1200;
var SECRETS_RE = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\bBearer\s+([A-Za-z0-9._\-+=]{20,})\b/gi,
  /\b[A-Z0-9_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*([^\s"']{8,})/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
];
var LEGACY_KEY_MAP = {
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
  inferredScore: "app.skill.score"
};
var contextStorage = new AsyncLocalStorage();
var logRecordSinks = /* @__PURE__ */ new Set();
function getSentryEnvironment() {
  return (process.env.SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "").trim().toLowerCase();
}
function shouldSuppressInfoLog(level) {
  return level === "info" && getSentryEnvironment() === "production";
}
function shouldEmitConsole(level) {
  if (process.env.NODE_ENV === "test") {
    return level === "error";
  }
  return getSentryEnvironment() !== "production";
}
function redactSecrets(input) {
  let out = input;
  for (const pattern of SECRETS_RE) {
    out = out.replace(pattern, (full, token) => {
      if (full.includes("PRIVATE KEY")) {
        const lines = full.trim().split("\n");
        return lines.length >= 2 ? `${lines[0]}
...redacted...
${lines[lines.length - 1]}` : "***PRIVATE KEY***";
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
function toSnakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
function isSemanticKey(key) {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_][a-z0-9_-]*)+$/.test(key);
}
function normalizeAttributeKey(key) {
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
function sanitizePrimitive(value) {
  if (value === null || value === void 0) return void 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return void 0;
    const redacted = redactSecrets(trimmed);
    return redacted.length > MAX_STRING_VALUE ? `${redacted.slice(0, MAX_STRING_VALUE)}...` : redacted;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (typeof value === "boolean") return value;
  if (value instanceof Error) {
    return redactSecrets(value.message);
  }
  try {
    const json = JSON.stringify(value);
    if (!json) return void 0;
    const redacted = redactSecrets(json);
    return redacted.length > MAX_STRING_VALUE ? `${redacted.slice(0, MAX_STRING_VALUE)}...` : redacted;
  } catch {
    return void 0;
  }
}
function sanitizeValue(value) {
  if (Array.isArray(value)) {
    const sanitized = value.filter((entry) => typeof entry === "string").map((entry) => sanitizePrimitive(entry)).filter((entry) => typeof entry === "string");
    return sanitized.length > 0 ? sanitized : void 0;
  }
  return sanitizePrimitive(value);
}
function contextToAttributes(context) {
  const attributes = {
    "app.platform": context.platform,
    "app.request.id": context.requestId,
    "messaging.system": context.platform === "slack" ? "slack" : context.platform,
    "messaging.message.conversation_id": context.slackThreadId,
    "messaging.destination.name": context.slackChannelId,
    "enduser.id": context.slackUserId,
    "enduser.pseudo_id": context.slackUserName,
    "app.workflow.run_id": context.workflowRunId,
    "app.assistant.username": context.assistantUserName,
    "gen_ai.request.model": context.modelId,
    "app.skill.name": context.skillName,
    "http.request.method": context.httpMethod,
    "url.path": context.httpPath,
    "url.full": context.urlFull,
    "user_agent.original": context.userAgent
  };
  const normalized = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitized = sanitizeValue(value);
    if (sanitized !== void 0) normalized[key] = sanitized;
  }
  return normalized;
}
function getTraceCorrelationAttributes() {
  const sentry = Sentry;
  if (typeof sentry.getActiveSpan !== "function" || typeof sentry.spanToJSON !== "function") {
    return {};
  }
  try {
    const span = sentry.getActiveSpan();
    if (!span) return {};
    const json = sentry.spanToJSON(span);
    const attrs = {};
    if (json.trace_id) attrs.trace_id = json.trace_id;
    if (json.span_id) attrs.span_id = json.span_id;
    return attrs;
  } catch {
    return {};
  }
}
function mergeAttributes(...maps) {
  const merged = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [rawKey, rawValue] of Object.entries(map)) {
      const key = normalizeAttributeKey(rawKey);
      const value = sanitizeValue(rawValue);
      if (value !== void 0) {
        merged[key] = value;
      }
    }
  }
  return merged;
}
function emitSentry(level, body, attributes) {
  if (shouldSuppressInfoLog(level)) {
    return;
  }
  const sentry = Sentry;
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
function formatConsoleLevel(level) {
  if (level === "debug") return "DBG";
  if (level === "info") return "INF";
  if (level === "warn") return "WRN";
  return "ERR";
}
function quoteConsoleValue(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function formatConsoleValue(value) {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return quoteConsoleValue(JSON.stringify(value));
  }
  if (/^[A-Za-z0-9._:/@+-]+$/.test(value)) {
    return value;
  }
  return quoteConsoleValue(value);
}
function formatConsoleLine(level, body, attributes) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const useColor = process.env.NODE_ENV === "development" && Boolean(process.stdout?.isTTY);
  const ANSI = {
    reset: "\x1B[0m",
    faint: "\x1B[2m",
    red: "\x1B[31m",
    yellow: "\x1B[33m",
    green: "\x1B[32m",
    blue: "\x1B[34m",
    cyan: "\x1B[36m",
    gray: "\x1B[90m"
  };
  const levelColor = level === "error" ? ANSI.red : level === "warn" ? ANSI.yellow : level === "info" ? ANSI.green : ANSI.blue;
  const colorize = (text, color) => useColor ? `${color}${text}${ANSI.reset}` : text;
  const parts = [
    `${colorize(timestamp, ANSI.gray)} ${colorize(formatConsoleLevel(level), levelColor)} ${body}`
  ];
  const priority = [
    "event.name",
    "error.message",
    "messaging.message.id",
    "messaging.message.conversation_id",
    "messaging.destination.name",
    "enduser.id",
    "app.workflow.run_id",
    "app.workflow.message_kind",
    "app.trace_id",
    "app.span_id"
  ];
  const priorityIndex = new Map(priority.map((key, index) => [key, index]));
  const sortedAttributes = Object.entries(attributes).sort(([left], [right]) => {
    const leftRank = priorityIndex.get(left);
    const rightRank = priorityIndex.get(right);
    if (leftRank !== void 0 || rightRank !== void 0) {
      if (leftRank === void 0) return 1;
      if (rightRank === void 0) return -1;
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
  for (const [key, value] of sortedAttributes) {
    const rendered = `${colorize(key, ANSI.cyan)}=${colorize(formatConsoleValue(value), ANSI.faint)}`;
    parts.push(rendered);
  }
  return parts.join(" ");
}
function emitConsole(level, _eventName, body, attributes) {
  if (!shouldEmitConsole(level)) {
    return;
  }
  const line = formatConsoleLine(level, body, attributes);
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
function emit(level, eventName, attrs = {}, body) {
  const contextAttributes = contextStorage.getStore() ?? {};
  const traceAttributes = getTraceCorrelationAttributes();
  const normalizedEventName = toSnakeCase(eventName);
  const message = body ? redactSecrets(body) : normalizedEventName;
  const attributes = mergeAttributes(
    contextAttributes,
    traceAttributes,
    {
      "event.name": normalizedEventName,
      ...attrs
    }
  );
  for (const sink of logRecordSinks) {
    try {
      sink({
        level,
        eventName: normalizedEventName,
        body: message,
        attributes
      });
    } catch {
    }
  }
  emitConsole(level, normalizedEventName, message, attributes);
  emitSentry(level, message, attributes);
}
var log = {
  debug(eventName, attrs = {}, body) {
    emit("debug", eventName, attrs, body);
  },
  info(eventName, attrs = {}, body) {
    emit("info", eventName, attrs, body);
  },
  warn(eventName, attrs = {}, body) {
    emit("warn", eventName, attrs, body);
  },
  error(eventName, attrs = {}, body) {
    emit("error", eventName, attrs, body);
  },
  exception(eventName, error, attrs = {}, body) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    emit("error", eventName, {
      ...attrs,
      "error.type": normalizedError.name,
      "error.message": normalizedError.message,
      "exception.type": normalizedError.name,
      "exception.message": normalizedError.message,
      "exception.stacktrace": normalizedError.stack
    }, body ?? normalizedError.message);
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(mergeAttributes(contextStorage.getStore(), attrs))) {
        scope.setExtra(key, value);
      }
      Sentry.captureException(normalizedError);
    });
  }
};
function withLogContext(context, callback) {
  const next = mergeAttributes(contextStorage.getStore(), contextToAttributes(context));
  return contextStorage.run(next, callback);
}
function setLogContext(context) {
  const merged = mergeAttributes(contextStorage.getStore(), contextToAttributes(context));
  contextStorage.enterWith(merged);
}
function createLogContextFromRequest(request, context = {}) {
  const url = new URL(request.url);
  return {
    ...context,
    requestId: context.requestId ?? request.headers.get("x-request-id") ?? void 0,
    httpMethod: request.method,
    httpPath: url.pathname,
    urlFull: url.toString(),
    userAgent: request.headers.get("user-agent") ?? void 0
  };
}
function toSpanAttributes(context) {
  const attrs = contextToAttributes(context);
  return Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => typeof value === "string" && value.length > 0)
  );
}
function setSentryTagsFromContext(context) {
  const attrs = contextToAttributes(context);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" && value.length > 0) {
      Sentry.setTag(key, value);
    }
  }
  if (context.slackUserId) {
    Sentry.setUser({ id: context.slackUserId, username: context.slackUserName });
  }
}
function setSentryScopeContext(scope, context) {
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

// src/chat/observability.ts
function toSpanAttributeValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (!Array.isArray(value)) {
    return void 0;
  }
  const sanitized = value.filter((entry) => typeof entry === "string");
  return sanitized.length > 0 ? sanitized : void 0;
}
function toContextAndAttributes(context, attributes) {
  return {
    ...toSpanAttributes(context),
    ...attributes
  };
}
function captureException3(error, context = {}) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception("exception_captured", normalizedError, toContextAndAttributes(context, {}), "Captured exception");
}
function logWithLevel(level, eventName, attributes = {}, body) {
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
function logInfo(eventName, context = {}, attributes = {}, body) {
  logWithLevel("info", eventName, toContextAndAttributes(context, attributes), body);
}
function logWarn(eventName, context = {}, attributes = {}, body) {
  logWithLevel("warn", eventName, toContextAndAttributes(context, attributes), body);
}
function logError(eventName, context = {}, attributes = {}, body) {
  logWithLevel("error", eventName, toContextAndAttributes(context, attributes), body);
}
function logException(error, eventName, context = {}, attributes = {}, body) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  log.exception(eventName, normalizedError, toContextAndAttributes(context, attributes), body);
}
function setTags(context = {}) {
  setLogContext(context);
  setSentryTagsFromContext(context);
}
function createRequestContext(request, context = {}) {
  return createLogContextFromRequest(request, context);
}
async function withContext(context, callback) {
  return withLogContext(context, callback);
}
async function withSpan(name, op, context, callback, attributes = {}) {
  const normalizedAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalizedValue = toSpanAttributeValue(value);
    if (normalizedValue !== void 0) {
      normalizedAttributes[key] = normalizedValue;
    }
  }
  return withLogContext(
    context,
    () => Sentry2.startSpan(
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
function setSpanAttributes(attributes) {
  const sentry = Sentry2;
  const span = sentry.getActiveSpan?.();
  if (!span) {
    return;
  }
  const setAttribute = span.setAttribute;
  if (typeof setAttribute !== "function") {
    return;
  }
  for (const [key, value] of Object.entries(attributes)) {
    const normalizedValue = toSpanAttributeValue(value);
    if (normalizedValue !== void 0) {
      setAttribute.call(span, key, normalizedValue);
    }
  }
}
function setSpanStatus(status) {
  const sentry = Sentry2;
  const span = sentry.getActiveSpan?.();
  if (!span) {
    return;
  }
  const setStatus = span.setStatus;
  if (typeof setStatus !== "function") {
    return;
  }
  setStatus.call(span, status === "ok" ? "ok" : "internal_error");
}
function captureExceptionInScope(error, context = {}) {
  Sentry2.withScope((scope) => {
    setSentryScopeContext(scope, context);
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    Sentry2.captureException(normalizedError);
  });
}
function toOptionalString(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}

export {
  captureException3 as captureException,
  logInfo,
  logWarn,
  logError,
  logException,
  setTags,
  createRequestContext,
  withContext,
  withSpan,
  setSpanAttributes,
  setSpanStatus,
  captureExceptionInScope,
  toOptionalString
};
