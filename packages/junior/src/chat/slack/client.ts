import { AsyncLocalStorage } from "node:async_hooks";
import { WebClient } from "@slack/web-api";
import { getSlackBotToken } from "@/chat/config";
import {
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
} from "@/chat/logging";
import {
  parseSlackChannelReferenceId,
  type SlackChannelId,
} from "@/chat/slack/ids";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { sleep } from "@/chat/sleep";

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
  | "already_reacted"
  | "no_reaction"
  | "read_only_channel"
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
  detail?: string;
  detailLine?: number;
  detailRule?: string;

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
      detail?: string;
      detailLine?: number;
      detailRule?: string;
    } = {},
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
    this.detail = options.detail;
    this.detailLine = options.detailLine;
    this.detailRule = options.detailRule;
  }
}

interface SlackRetryContext {
  action?: string;
  attributes?: Record<string, string | number | boolean>;
  /**
   * Whether repeating the operation cannot produce a duplicate user-visible
   * effect (reads, deletes, reactions). Request timeouts are ambiguous — Slack
   * may have accepted the write — so they are only retried when the caller
   * marks the operation idempotent. Defaults to false (never risk a duplicate
   * post).
   */
  idempotent?: boolean;
  /** Extra attributes forwarded onto the per-attempt Sentry span. */
  spanAttributes?: Record<string, string | number | boolean>;
}

function serializeSlackErrorData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const filtered = Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(
      ([key]) => key !== "error",
    ),
  );
  if (Object.keys(filtered).length === 0) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(filtered);
    return serialized.length <= 600
      ? serialized
      : `${serialized.slice(0, 597)}...`;
  } catch {
    return undefined;
  }
}

/** Extract a header value by case-insensitive name from a raw headers object. */
export function getHeaderString(
  headers: unknown,
  name: string,
): string | undefined {
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

function parseSlackCanvasDetail(detail: unknown): {
  detail?: string;
  detailLine?: number;
  detailRule?: string;
} {
  if (typeof detail !== "string") {
    return {};
  }

  const trimmed = detail.trim();
  if (!trimmed) {
    return {};
  }

  const parsed: {
    detail?: string;
    detailLine?: number;
    detailRule?: string;
  } = {
    detail: trimmed,
  };
  const lineMatch = trimmed.match(/line\s+(\d+):/i);
  if (lineMatch) {
    const line = Number.parseInt(lineMatch[1] ?? "", 10);
    if (Number.isFinite(line)) {
      parsed.detailLine = line;
    }
  }

  if (/unsupported heading depth/i.test(trimmed)) {
    parsed.detailRule = "unsupported_heading_depth";
  }

  return parsed;
}

/**
 * Ambient destination-installation token for Slack outbound calls, bound by
 * installation-scoped entry points so writes carry the destination
 * workspace's credentials instead of the process-global env token.
 */
const installationTokenStorage = new AsyncLocalStorage<{ token: string }>();

const clientsByToken = new Map<string, WebClient>();

/**
 * Bind a workspace installation token for all Slack Web API calls inside
 * `fn`, so multi-workspace outbound writes use the destination workspace's
 * credentials rather than the env fallback token.
 */
export function runWithSlackInstallationToken<T>(
  token: string,
  fn: () => T,
): T {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new SlackActionError(
      "Slack installation token binding requires a non-empty token",
      "missing_token",
    );
  }
  return installationTokenStorage.run({ token: trimmed }, fn);
}

/**
 * Token precedence: ambient installation token, then env token, then a hard
 * failure for team-scoped calls — a call scoped to one workspace must never
 * silently fall through to another workspace's credentials.
 */
function resolveSlackToken(): string {
  const ambientToken = installationTokenStorage.getStore()?.token;
  if (ambientToken) {
    return ambientToken;
  }

  // The env token mirrors the Slack adapter's single-workspace mode: when a
  // default bot token is configured, installation-scoped entry points do not
  // bind a per-team token because the env token is the workspace's token.
  const envToken = getSlackBotToken();
  if (envToken) {
    return envToken;
  }

  const teamId = getWorkspaceTeamId();
  if (teamId) {
    throw new SlackActionError(
      `Slack call is scoped to workspace ${teamId} but no installation token is bound and no default bot token is configured`,
      "missing_token",
    );
  }

  throw new SlackActionError(
    "SLACK_BOT_TOKEN (or SLACK_BOT_USER_TOKEN) is required for Slack Web API actions in this service",
    "missing_token",
  );
}

/** Normalize Junior Slack references to native Slack conversation IDs. */
export function normalizeSlackConversationId(
  channelId: string | undefined,
): SlackChannelId | undefined {
  return parseSlackChannelReferenceId(channelId);
}

/**
 * Return the per-token cached WebClient. `withSlackRetries` owns retry
 * classification for this boundary: the WebClient's built-in policy would
 * re-post timed-out writes (a duplicate-message hazard) and sleep for the
 * full unbounded Retry-After inside the request, so both internal behaviors
 * are disabled here.
 */
function getClient(): WebClient {
  const token = resolveSlackToken();
  let cached = clientsByToken.get(token);
  if (!cached) {
    cached = new WebClient(token, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
    clientsByToken.set(token, cached);
  }
  return cached;
}

function mapSlackError(error: unknown): SlackActionError {
  if (error instanceof SlackActionError) {
    return error;
  }

  const candidate = error as {
    data?: { error?: string; needed?: string; provided?: string } & Record<
      string,
      unknown
    >;
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
    errorData: serializeSlackErrorData(candidate.data),
    ...parseSlackCanvasDetail(candidate.data?.detail),
  };

  if (apiError === "missing_scope") {
    return new SlackActionError(message, "missing_scope", {
      ...baseOptions,
      needed: candidate.data?.needed,
      provided: candidate.data?.provided,
    });
  }

  if (apiError === "not_in_channel") {
    return new SlackActionError(message, "not_in_channel", baseOptions);
  }

  if (apiError === "restricted_action_read_only_channel") {
    return new SlackActionError(message, "read_only_channel", baseOptions);
  }

  if (apiError === "already_reacted") {
    return new SlackActionError(message, "already_reacted", baseOptions);
  }

  if (apiError === "no_reaction") {
    return new SlackActionError(message, "no_reaction", baseOptions);
  }

  if (apiError === "invalid_arguments") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }

  if (apiError === "invalid_cursor") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }

  if (apiError === "invalid_name") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }

  if (
    apiError === "not_found" ||
    apiError === "channel_not_found" ||
    apiError === "message_not_found"
  ) {
    return new SlackActionError(message, "not_found", baseOptions);
  }

  if (
    apiError === "feature_not_enabled" ||
    apiError === "not_allowed_token_type"
  ) {
    return new SlackActionError(message, "feature_unavailable", baseOptions);
  }

  if (apiError === "canvas_creation_failed") {
    return new SlackActionError(message, "canvas_creation_failed", baseOptions);
  }

  if (apiError === "canvas_editing_failed") {
    return new SlackActionError(message, "canvas_editing_failed", baseOptions);
  }

  if (
    candidate.code === "slack_webapi_rate_limited_error" ||
    candidate.statusCode === 429
  ) {
    return new SlackActionError(message, "rate_limited", {
      ...baseOptions,
      retryAfterSeconds: candidate.retryAfter,
    });
  }

  return new SlackActionError(message, "internal_error", baseOptions);
}

// Retry pauses are bounded so a hostile or huge Retry-After header cannot eat
// the remaining serverless execution slice during final delivery.
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_TOTAL_RETRY_DELAY_MS = 20_000;

// Connection-phase failures: the request is known not to have reached Slack,
// so retrying can never duplicate a write.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// Timeouts are ambiguous: Slack may have accepted the request before the
// deadline elapsed, so these are only retried for idempotent operations.
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "ESOCKETTIMEDOUT",
]);

type SlackRetryClass =
  | "rate_limited"
  | "connection"
  | "timeout"
  | "server_error"
  | "none";

function findNetworkErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) {
    return undefined;
  }
  const candidate = error as {
    code?: unknown;
    original?: unknown;
    cause?: unknown;
  };
  if (
    typeof candidate.code === "string" &&
    (CONNECTION_ERROR_CODES.has(candidate.code) ||
      TIMEOUT_ERROR_CODES.has(candidate.code))
  ) {
    return candidate.code;
  }
  return (
    findNetworkErrorCode(candidate.original, depth + 1) ??
    findNetworkErrorCode(candidate.cause, depth + 1)
  );
}

function hasSocketHangUpMessage(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("socket hang up")
  );
}

/**
 * Classify a failed Slack call for retry: rate limits, Slack 5xx, and
 * connection-phase failures are always retryable; timeouts are retried only
 * for idempotent operations because Slack may already have accepted the
 * request.
 */
function classifySlackRetry(
  raw: unknown,
  mapped: SlackActionError,
): SlackRetryClass {
  if (mapped.code === "rate_limited") {
    return "rate_limited";
  }
  if (mapped.statusCode !== undefined && mapped.statusCode >= 500) {
    return "server_error";
  }
  const networkCode = findNetworkErrorCode(raw);
  if (networkCode && CONNECTION_ERROR_CODES.has(networkCode)) {
    return "connection";
  }
  if (networkCode && TIMEOUT_ERROR_CODES.has(networkCode)) {
    return "timeout";
  }
  // A hang-up before any response was received never reached Slack's API
  // layer, so it is safe to retry alongside other connection-phase failures.
  if (hasSocketHangUpMessage(raw)) {
    return "connection";
  }
  return "none";
}

/**
 * Run a Slack Web API call with bounded retries so transient platform
 * failures do not surface as turn failures, while non-idempotent posts are
 * never re-sent when Slack may already have accepted them.
 *
 * Retry classes: rate limits (bounded Retry-After), connection-phase network
 * failures, and Slack 5xx responses always retry; request timeouts retry only
 * when the caller marks the operation `idempotent`.
 */
export async function withSlackRetries<T>(
  task: () => Promise<T>,
  maxAttempts = 3,
  context: SlackRetryContext = {},
): Promise<T> {
  let attempt = 0;
  let totalDelayMs = 0;

  const action = context.action ?? "unknown";

  while (attempt < maxAttempts) {
    attempt += 1;
    const attemptNumber = attempt;
    try {
      return await withSpan(
        `POST slack.com/api/${action}`,
        "http.client",
        {},
        async () => {
          try {
            return await task();
          } catch (error) {
            const mapped = mapSlackError(error);
            const errorAttrs: Record<string, string | number | boolean> = {
              "error.type": mapped.code,
            };
            if (mapped.apiError) {
              errorAttrs["app.slack.api_error_code"] = mapped.apiError;
            }
            if (mapped.code === "rate_limited") {
              errorAttrs["http.response.status_code"] = 429;
              if (mapped.retryAfterSeconds) {
                errorAttrs["app.slack.retry_after_ms"] =
                  mapped.retryAfterSeconds * 1000;
              }
            } else if (mapped.statusCode != null) {
              errorAttrs["http.response.status_code"] = mapped.statusCode;
            }
            setSpanAttributes(errorAttrs);
            setSpanStatus("error");
            throw error;
          }
        },
        {
          "http.request.method": "POST",
          "server.address": "slack.com",
          "url.scheme": "https",
          "url.path": `/api/${action}`,
          "app.slack.method": action,
          "app.retry.max_attempts": maxAttempts,
          ...(attemptNumber > 1
            ? { "http.resend_count": attemptNumber - 1 }
            : {}),
          ...(context.attributes ?? {}),
          ...(context.spanAttributes ?? {}),
        },
      );
    } catch (error) {
      const mapped = mapSlackError(error);
      const retryClass = classifySlackRetry(error, mapped);
      const isRetryable =
        retryClass === "rate_limited" ||
        retryClass === "connection" ||
        retryClass === "server_error" ||
        (retryClass === "timeout" && context.idempotent === true);
      const remainingDelayBudgetMs = MAX_TOTAL_RETRY_DELAY_MS - totalDelayMs;
      const baseLogAttributes: Record<string, string | number | boolean> = {
        "app.slack.action": action,
        "app.slack.error_code": mapped.code,
        ...(mapped.apiError ? { "app.slack.api_error": mapped.apiError } : {}),
        ...(mapped.detail ? { "app.slack.detail": mapped.detail } : {}),
        ...(mapped.detailLine !== undefined
          ? { "app.slack.detail_line": mapped.detailLine }
          : {}),
        ...(mapped.detailRule
          ? { "app.slack.detail_rule": mapped.detailRule }
          : {}),
        ...(mapped.requestId
          ? { "app.slack.request_id": mapped.requestId }
          : {}),
        ...(mapped.statusCode !== undefined
          ? { "http.response.status_code": mapped.statusCode }
          : {}),
        ...(context.attributes ?? {}),
      };

      if (
        !isRetryable ||
        attempt >= maxAttempts ||
        remainingDelayBudgetMs <= 0
      ) {
        logWarn(
          "slack_action_failed",
          {},
          {
            ...baseLogAttributes,
            ...(mapped.errorData
              ? { "app.slack.error_data": mapped.errorData }
              : {}),
          },
          "Slack action failed",
        );
        throw mapped;
      }

      logWarn(
        "slack_action_retrying",
        {},
        {
          ...baseLogAttributes,
          "app.slack.retry_attempt": attempt,
          "app.slack.retry_class": retryClass,
        },
        "Retrying Slack action after transient failure",
      );

      const retryAfterMs =
        retryClass === "rate_limited" &&
        mapped.retryAfterSeconds &&
        mapped.retryAfterSeconds > 0
          ? mapped.retryAfterSeconds * 1000
          : undefined;
      const backoffMs = Math.min(2000, 250 * 2 ** (attempt - 1));
      const delayMs = Math.min(
        retryAfterMs ?? backoffMs,
        MAX_RETRY_DELAY_MS,
        remainingDelayBudgetMs,
      );
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }

  throw new SlackActionError(
    "Slack action exhausted retries",
    "internal_error",
  );
}

/**
 * Slack Web API client for the current destination workspace: the ambient
 * installation token when one is bound, otherwise the env bot token for
 * single-workspace deployments. Fails instead of falling back when the call
 * is workspace-scoped and no installation token can be resolved, so a write
 * never goes out with another workspace's credentials.
 */
export function getSlackClient(): WebClient {
  return getClient();
}

/**
 * Slack channel ID prefixes:
 * - C: channel — modern private channels also use C, so the prefix never
 *   proves a channel is public
 * - G: legacy private channel / group DM
 * - D: direct message (1:1)
 */
export function isDmChannel(channelId: string): boolean {
  const normalized = normalizeSlackConversationId(channelId);
  return Boolean(normalized && normalized.startsWith("D"));
}

/**
 * Conversation-scoped Slack contexts backed by a concrete conversation ID.
 * Includes channels/groups/DMs (C/G/D).
 */
export function isConversationScopedChannel(
  channelId: string | undefined,
): boolean {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return (
    normalized.startsWith("C") ||
    normalized.startsWith("G") ||
    normalized.startsWith("D")
  );
}

export function isConversationChannel(channelId: string | undefined): boolean {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return normalized.startsWith("C") || normalized.startsWith("G");
}

export async function getFilePermalink(
  fileId: string,
): Promise<string | undefined> {
  const client = getClient();
  const response = await withSlackRetries(
    () =>
      client.files.info({
        file: fileId,
      }),
    3,
    {
      action: "files.info",
      idempotent: true,
      spanAttributes: { "app.slack.file_id": fileId },
    },
  );

  return response.file?.permalink;
}

export async function downloadPrivateSlackFile(url: string): Promise<Buffer> {
  // Private file URLs are workspace-scoped, so downloads use the same
  // destination-installation token resolution as Web API calls.
  const token = resolveSlackToken();

  return withSpan(
    "GET files.slack.com",
    "http.client",
    {},
    async () => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      setSpanAttributes({ "http.response.status_code": response.status });
      if (!response.ok) {
        setSpanAttributes({ "error.type": String(response.status) });
        setSpanStatus("error");
        throw new Error(`Slack file download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    {
      "http.request.method": "GET",
      "server.address": "files.slack.com",
      "url.scheme": "https",
      "app.slack.method": "files.download",
    },
  );
}
