import {
  getSlackBotToken
} from "./chunk-OXUT4WDZ.js";
import {
  logWarn
} from "./chunk-OXCKLXL3.js";

// src/chat/slack-actions/client.ts
import { WebClient } from "@slack/web-api";
var SlackActionError = class extends Error {
  code;
  apiError;
  needed;
  provided;
  statusCode;
  requestId;
  errorData;
  retryAfterSeconds;
  constructor(message, code, options = {}) {
    super(message);
    this.name = "SlackActionError";
    this.code = code;
    this.apiError = options.apiError;
    this.needed = options.needed;
    this.provided = options.provided;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.errorData = options.errorData;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
};
function serializeSlackErrorData(data) {
  if (!data || typeof data !== "object") {
    return void 0;
  }
  const filtered = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== "error")
  );
  if (Object.keys(filtered).length === 0) {
    return void 0;
  }
  try {
    const serialized = JSON.stringify(filtered);
    return serialized.length <= 600 ? serialized : `${serialized.slice(0, 597)}...`;
  } catch {
    return void 0;
  }
}
function getHeaderString(headers, name) {
  if (!headers || typeof headers !== "object") {
    return void 0;
  }
  const key = name.toLowerCase();
  const entries = headers;
  for (const [entryKey, value] of Object.entries(entries)) {
    if (entryKey.toLowerCase() !== key) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      return typeof first === "string" ? first : void 0;
    }
  }
  return void 0;
}
var client = null;
function normalizeSlackConversationId(channelId) {
  if (!channelId) return void 0;
  const trimmed = channelId.trim();
  if (!trimmed) return void 0;
  if (!trimmed.startsWith("slack:")) {
    return trimmed;
  }
  const parts = trimmed.split(":");
  return parts[1]?.trim() || void 0;
}
function getClient() {
  if (client) return client;
  const token = getSlackBotToken();
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN (or SLACK_BOT_USER_TOKEN) is required for Slack canvas/list actions in this service",
      "missing_token"
    );
  }
  client = new WebClient(token);
  return client;
}
function mapSlackError(error) {
  if (error instanceof SlackActionError) {
    return error;
  }
  const candidate = error;
  const apiError = candidate.data?.error;
  const message = candidate.message ?? "Slack action failed";
  const baseOptions = {
    apiError,
    statusCode: candidate.statusCode,
    requestId: getHeaderString(candidate.headers, "x-slack-req-id"),
    errorData: serializeSlackErrorData(candidate.data)
  };
  if (apiError === "missing_scope") {
    return new SlackActionError(message, "missing_scope", {
      ...baseOptions,
      needed: candidate.data?.needed,
      provided: candidate.data?.provided
    });
  }
  if (apiError === "not_in_channel") {
    return new SlackActionError(message, "not_in_channel", baseOptions);
  }
  if (apiError === "invalid_arguments") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }
  if (apiError === "invalid_name") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }
  if (apiError === "not_found") {
    return new SlackActionError(message, "not_found", baseOptions);
  }
  if (apiError === "feature_not_enabled" || apiError === "not_allowed_token_type") {
    return new SlackActionError(message, "feature_unavailable", baseOptions);
  }
  if (apiError === "canvas_creation_failed") {
    return new SlackActionError(message, "canvas_creation_failed", baseOptions);
  }
  if (apiError === "canvas_editing_failed") {
    return new SlackActionError(message, "canvas_editing_failed", baseOptions);
  }
  if (candidate.code === "slack_webapi_rate_limited_error" || candidate.statusCode === 429) {
    return new SlackActionError(message, "rate_limited", {
      ...baseOptions,
      retryAfterSeconds: candidate.retryAfter
    });
  }
  return new SlackActionError(message, "internal_error", baseOptions);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withSlackRetries(task, maxAttempts = 3, context = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const mapped = mapSlackError(error);
      const isRetryable = mapped.code === "rate_limited";
      const baseLogAttributes = {
        "app.slack.action": context.action ?? "unknown",
        "app.slack.error_code": mapped.code,
        ...mapped.apiError ? { "app.slack.api_error": mapped.apiError } : {},
        ...mapped.requestId ? { "app.slack.request_id": mapped.requestId } : {},
        ...mapped.statusCode !== void 0 ? { "http.response.status_code": mapped.statusCode } : {},
        ...context.attributes ?? {}
      };
      if (!isRetryable || attempt >= maxAttempts) {
        logWarn(
          "slack_action_failed",
          {},
          {
            ...baseLogAttributes,
            ...mapped.errorData ? { "app.slack.error_data": mapped.errorData } : {}
          },
          "Slack action failed"
        );
        throw mapped;
      }
      logWarn(
        "slack_action_retrying",
        {},
        {
          ...baseLogAttributes,
          "app.slack.retry_attempt": attempt
        },
        "Retrying Slack action after transient failure"
      );
      const retryAfterMs = mapped.code === "rate_limited" && mapped.retryAfterSeconds && mapped.retryAfterSeconds > 0 ? mapped.retryAfterSeconds * 1e3 : void 0;
      const backoffMs = Math.min(2e3, 250 * 2 ** (attempt - 1));
      await sleep(retryAfterMs ?? backoffMs);
    }
  }
  throw new SlackActionError("Slack action exhausted retries", "internal_error");
}
function getSlackClient() {
  return getClient();
}
function isDmChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  return Boolean(normalized && normalized.startsWith("D"));
}
function isConversationScopedChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return normalized.startsWith("C") || normalized.startsWith("G") || normalized.startsWith("D");
}
function isConversationChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return normalized.startsWith("C") || normalized.startsWith("G");
}
async function getFilePermalink(fileId) {
  const client2 = getClient();
  const response = await withSlackRetries(
    () => client2.files.info({
      file: fileId
    })
  );
  return response.file?.permalink;
}
async function uploadFilesToThread(args) {
  const client2 = getClient();
  await withSlackRetries(
    () => client2.filesUploadV2({
      channel_id: args.channelId,
      thread_ts: args.threadTs,
      file_uploads: args.files.map((f) => ({
        file: f.data,
        filename: f.filename
      }))
    })
  );
}
async function downloadPrivateSlackFile(url) {
  const token = getSlackBotToken();
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN (or SLACK_BOT_USER_TOKEN) is required for Slack file downloads in this service",
      "missing_token"
    );
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export {
  SlackActionError,
  normalizeSlackConversationId,
  withSlackRetries,
  getSlackClient,
  isDmChannel,
  isConversationScopedChannel,
  isConversationChannel,
  getFilePermalink,
  uploadFilesToThread,
  downloadPrivateSlackFile
};
