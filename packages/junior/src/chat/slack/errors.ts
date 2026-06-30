import { getHeaderString } from "@/chat/slack/client";

/** Extract Slack's stable API error code from Web API errors. */
export function getSlackApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as {
    code?: unknown;
    data?: { error?: unknown };
  };

  if (
    typeof candidate.data?.error === "string" &&
    candidate.data.error.trim().length > 0
  ) {
    return candidate.data.error;
  }
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    return candidate.code;
  }

  return undefined;
}

/** Convert Slack Web API error details into the repository's trace attributes. */
export function getSlackErrorObservabilityAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!error || typeof error !== "object") {
    return {};
  }

  const candidate = error as {
    code?: unknown;
    data?: { error?: unknown };
    headers?: unknown;
    statusCode?: unknown;
  };

  const attributes: Record<string, string | number> = {};
  if (typeof candidate.code === "string" && candidate.code.trim().length > 0) {
    attributes["app.slack.error_code"] = candidate.code;
  }
  if (
    typeof candidate.data?.error === "string" &&
    candidate.data.error.trim().length > 0
  ) {
    attributes["app.slack.api_error"] = candidate.data.error;
  }
  const requestId = getHeaderString(candidate.headers, "x-slack-req-id");
  if (requestId) {
    attributes["app.slack.request_id"] = requestId;
  }
  if (
    typeof candidate.statusCode === "number" &&
    Number.isFinite(candidate.statusCode)
  ) {
    attributes["http.response.status_code"] = candidate.statusCode;
  }

  return attributes;
}

/** Report whether Slack rejected assistant title updates for stable auth reasons. */
export function isSlackTitlePermissionError(error: unknown): boolean {
  const code = getSlackApiErrorCode(error);
  return (
    code === "no_permission" ||
    code === "missing_scope" ||
    code === "not_allowed_token_type"
  );
}
