import { WebClient } from "@slack/web-api";

// Slack canvas/list methods are not exposed by the current chat adapter public API,
// so this module owns direct Web API calls for artifact actions.
export type SlackActionErrorCode =
  | "missing_token"
  | "missing_scope"
  | "rate_limited"
  | "feature_unavailable"
  | "invalid_arguments"
  | "not_found"
  | "not_in_channel"
  | "internal_error";

export class SlackActionError extends Error {
  code: SlackActionErrorCode;
  needed?: string;
  provided?: string;

  constructor(message: string, code: SlackActionErrorCode, options: { needed?: string; provided?: string } = {}) {
    super(message);
    this.name = "SlackActionError";
    this.code = code;
    this.needed = options.needed;
    this.provided = options.provided;
  }
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
    data?: { error?: string; needed?: string; provided?: string };
    message?: string;
    code?: string;
    statusCode?: number;
    retryAfter?: number;
  };

  const apiError = candidate.data?.error;
  const message = candidate.message ?? "Slack action failed";

  if (apiError === "missing_scope") {
    return new SlackActionError(message, "missing_scope", {
      needed: candidate.data?.needed,
      provided: candidate.data?.provided
    });
  }

  if (apiError === "not_in_channel") {
    return new SlackActionError(message, "not_in_channel");
  }

  if (apiError === "invalid_arguments") {
    return new SlackActionError(message, "invalid_arguments");
  }

  if (apiError === "not_found") {
    return new SlackActionError(message, "not_found");
  }

  if (apiError === "feature_not_enabled" || apiError === "not_allowed_token_type") {
    return new SlackActionError(message, "feature_unavailable");
  }

  if (candidate.code === "slack_webapi_rate_limited_error" || candidate.statusCode === 429) {
    return new SlackActionError(message, "rate_limited");
  }

  return new SlackActionError(message, "internal_error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSlackRetries<T>(task: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const mapped = mapSlackError(error);
      const isRetryable = mapped.code === "rate_limited" || mapped.code === "internal_error";
      if (!isRetryable || attempt >= maxAttempts) {
        throw mapped;
      }

      await sleep(250 * attempt);
    }
  }

  throw new SlackActionError("Slack action exhausted retries", "internal_error");
}

export function getSlackClient(): WebClient {
  return getClient();
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
