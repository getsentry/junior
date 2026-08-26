import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";

/** Title for one failed turn in the transcript. */
export function transcriptFailureTitle(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
): string {
  if (failureCode === "model_execution_failed" && failureReason) {
    switch (failureReason) {
      case "auth":
        return "Model credentials rejected";
      case "permission":
        return "Model access denied";
      case "rate_limit":
        return "Model rate limited";
      case "capacity":
        return "Model at capacity";
      case "timeout":
        return "Model timed out";
      case "network":
        return "Model connection failed";
      case "server":
        return "Model service error";
      case "invalid_request":
        return "Invalid model request";
      case "invalid_response":
        return "Invalid model response";
      case "quota":
        return "Model quota exhausted";
      case "content_policy":
        return "Blocked by content policy";
      case "empty_output":
        return "Empty model response";
      case "tool_errors":
        return "Tool failed";
      case "suppressed_output":
        return "Model output was dropped";
      case "workspace_snapshot_not_ready":
        return "Workspace still preparing";
      case "unknown":
        return "Model service error";
    }
  }

  if (failureReason === "workspace_snapshot_not_ready") {
    return "Workspace still preparing";
  }

  switch (failureCode) {
    case "delivery_failed":
      return "Message delivery failed";
    case "model_execution_failed":
      return "Model failed";
    case "persistence_failed":
      return "Save failed";
    case "agent_run_failed":
      return "Internal error";
  }

  return "Internal error";
}

/** Short description for one failed turn in the transcript. */
export function transcriptFailureDescription(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
): string {
  const agentName = getDashboardAgentName();

  if (failureCode === "model_execution_failed" && failureReason) {
    switch (failureReason) {
      case "auth":
        return "The model service rejected credentials. An admin needs to fix configuration.";
      case "permission":
        return "The model service denied access to this model or request.";
      case "rate_limit":
        return "The model is rate limited. Try again shortly.";
      case "capacity":
        return "The selected model is at capacity. Try again shortly.";
      case "timeout":
        return "The model service timed out before the turn finished.";
      case "network":
        return "The model service had a connection problem before the turn finished.";
      case "server":
        return "The model service returned an error.";
      case "invalid_request":
        return "The model service rejected this request as invalid.";
      case "invalid_response":
        return "The model service returned an invalid response.";
      case "quota":
        return "The model service quota is exhausted. An admin needs to fix billing or limits.";
      case "content_policy":
        return "The model service blocked this request under its content policy.";
      case "empty_output":
        return `The model returned no usable text before ${agentName} finished this turn.`;
      case "tool_errors":
        return "A tool failed and the turn could not finish.";
      case "suppressed_output":
        return `The model produced text that ${agentName} could not deliver.`;
      case "workspace_snapshot_not_ready":
        return "The workspace is still preparing its sandbox. Wait for that preparation to finish, then try again.";
      case "unknown":
        return "The model service failed for an unknown reason.";
    }
  }

  if (failureReason === "workspace_snapshot_not_ready") {
    return "The workspace is still preparing its sandbox. Wait for that preparation to finish, then try again.";
  }

  switch (failureCode) {
    case "delivery_failed":
      return `${agentName} could not deliver this message.`;
    case "model_execution_failed":
      return `The model stopped before ${agentName} finished this turn.`;
    case "persistence_failed":
      return `${agentName} could not save the result of this turn.`;
    case "agent_run_failed":
      return `${agentName} hit an internal error during this turn.`;
  }

  return `${agentName} hit an internal error during this turn.`;
}

/** Search text for one failed turn in the transcript. */
export function transcriptFailureSearchText(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
): string {
  return [
    transcriptFailureTitle(failureCode, failureReason),
    transcriptFailureDescription(failureCode, failureReason),
    failureCode.replaceAll("_", " "),
    ...(failureReason ? [failureReason.replaceAll("_", " ")] : []),
  ].join(" ");
}
