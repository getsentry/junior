import { WebClient } from "@slack/web-api";
import { logWarn } from "@/chat/observability";

// Slack canvas/list methods are not exposed by the current chat adapter public API,
// so this module owns direct Web API calls for artifact actions.
export type SlackActionErrorCode =
  | "missing_token"
  | "missing_scope"
  | "rate_limited"
  | "feature_unavailable"
  | "canvas_creation_failed"
  | "canvas_editing_failed"
  | "invalid_arguments"
  | "not_found"
  | "not_in_channel"
  | "internal_error";

export class SlackActionError extends Error {
  code: SlackActionErrorCode;
  apiError?: string;
  needed?: string;
  provided?: string;
  statusCode?: number;
  requestId?: string;
  errorData?: string;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    code: SlackActionErrorCode,
    options: {
      apiError?: string;
      needed?: string;
      provided?: string;
      statusCode?: number;
      requestId?: string;
      errorData?: string;
      retryAfterSeconds?: number;
    } = {}
  ) {
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
}

interface SlackRetryContext {
  action?: string;
  attributes?: Record<string, string | number | boolean>;
}

function serializeSlackErrorData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const filtered = Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "error")
  );
  if (Object.keys(filtered).length === 0) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(filtered);
    return serialized.length <= 600 ? serialized : `${serialized.slice(0, 597)}...`;
  } catch {
    return undefined;
  }
}

function getHeaderString(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const key = name.toLowerCase();
  const entries = headers as Record<string, unknown>;
  for (const [entryKey, value] of Object.entries(entries)) {
    if (entryKey.toLowerCase() !== key) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      return typeof first === "string" ? first : undefined;
    }
  }

  return undefined;
}

let client: WebClient | null = null;

function getClient(): WebClient {
  if (client) return client;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN is required for Slack canvas/list actions in this service",
      "missing_token"
    );
  }

  client = new WebClient(token);
  return client;
}

function mapSlackError(error: unknown): SlackActionError {
  if (error instanceof SlackActionError) {
    return error;
  }

  const candidate = error as {
    data?: { error?: string; needed?: string; provided?: string } & Record<string, unknown>;
    message?: string;
    code?: string;
    statusCode?: number;
    retryAfter?: number;
    headers?: Record<string, unknown>;
  };

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSlackRetries<T>(
  task: () => Promise<T>,
  maxAttempts = 3,
  context: SlackRetryContext = {}
): Promise<T> {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const mapped = mapSlackError(error);
      const isRetryable = mapped.code === "rate_limited";
      if (!isRetryable || attempt >= maxAttempts) {
        logWarn(
          "slack_action_failed",
          {},
          {
            "app.slack.action": context.action ?? "unknown",
            "app.slack.error_code": mapped.code,
            ...(mapped.apiError ? { "app.slack.api_error": mapped.apiError } : {}),
            ...(mapped.requestId ? { "app.slack.request_id": mapped.requestId } : {}),
            ...(mapped.errorData ? { "app.slack.error_data": mapped.errorData } : {}),
            ...(mapped.statusCode !== undefined ? { "http.response.status_code": mapped.statusCode } : {}),
            ...(context.attributes ?? {})
          },
          "Slack action failed"
        );
        throw mapped;
      }

      logWarn(
        "slack_action_retrying",
        {},
        {
          "app.slack.action": context.action ?? "unknown",
          "app.slack.error_code": mapped.code,
          ...(mapped.apiError ? { "app.slack.api_error": mapped.apiError } : {}),
          ...(mapped.requestId ? { "app.slack.request_id": mapped.requestId } : {}),
          ...(mapped.statusCode !== undefined ? { "http.response.status_code": mapped.statusCode } : {}),
          "app.slack.retry_attempt": attempt,
          ...(context.attributes ?? {})
        },
        "Retrying Slack action after transient failure"
      );

      const retryAfterMs =
        mapped.code === "rate_limited" && mapped.retryAfterSeconds && mapped.retryAfterSeconds > 0
          ? mapped.retryAfterSeconds * 1000
          : undefined;
      const backoffMs = Math.min(2000, 250 * 2 ** (attempt - 1));
      await sleep(retryAfterMs ?? backoffMs);
    }
  }

  throw new SlackActionError("Slack action exhausted retries", "internal_error");
}

export function getSlackClient(): WebClient {
  return getClient();
}

/**
 * Slack channel ID prefixes:
 * - C: public channel
 * - G: private channel / group DM
 * - D: direct message (1:1)
 */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

export function isConversationChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return channelId.startsWith("C") || channelId.startsWith("G");
}

export async function getFilePermalink(fileId: string): Promise<string | undefined> {
  const client = getClient();
  const response = await withSlackRetries(() =>
    client.files.info({
      file: fileId
    })
  );

  return response.file?.permalink;
}

export async function uploadFilesToThread(args: {
  channelId: string;
  threadTs: string;
  files: Array<{ data: Buffer; filename: string }>;
}): Promise<void> {
  const client = getClient();
  await withSlackRetries(() =>
    client.filesUploadV2({
      channel_id: args.channelId,
      thread_ts: args.threadTs,
      file_uploads: args.files.map((f) => ({
        file: f.data,
        filename: f.filename
      }))
    })
  );
}

export async function downloadPrivateSlackFile(url: string): Promise<Buffer> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN is required for Slack file downloads in this service",
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
