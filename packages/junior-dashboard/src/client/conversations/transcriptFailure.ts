import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";

const FAILURE_REASON_TITLES = {
  auth: "Model credentials rejected",
  permission: "Model access denied",
  rate_limit: "Model rate limited",
  capacity: "Model at capacity",
  timeout: "Model timed out",
  network: "Model connection failed",
  server: "Model service error",
  invalid_request: "Invalid model request",
  invalid_response: "Invalid model response",
  quota: "Model quota exhausted",
  content_policy: "Blocked by content policy",
  empty_output: "Empty model response",
  tool_errors: "Tool failed",
  suppressed_output: "Model output was dropped",
  unknown: "Model service error",
} satisfies Record<ConversationTurnFailureReason, string>;

const FAILURE_CODE_TITLES = {
  delivery_failed: "Message delivery failed",
  model_execution_failed: "Model failed",
  persistence_failed: "Save failed",
  agent_run_failed: "Internal error",
} satisfies Record<ConversationTurnFailureCode, string>;

/** Title for one failed turn in the transcript. */
export function transcriptFailureTitle(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
): string {
  if (failureCode === "model_execution_failed" && failureReason) {
    return FAILURE_REASON_TITLES[failureReason];
  }
  return FAILURE_CODE_TITLES[failureCode];
}

function failureReasonDescriptions(agentName: string) {
  return {
    auth: "The model service rejected credentials. An admin needs to fix configuration.",
    permission: "The model service denied access to this model or request.",
    rate_limit: "The model is rate limited. Try again shortly.",
    capacity: "The selected model is at capacity. Try again shortly.",
    timeout: "The model service timed out before the turn finished.",
    network:
      "The model service had a connection problem before the turn finished.",
    server: "The model service returned an error.",
    invalid_request: "The model service rejected this request as invalid.",
    invalid_response: "The model service returned an invalid response.",
    quota:
      "The model service quota is exhausted. An admin needs to fix billing or limits.",
    content_policy:
      "The model service blocked this request under its content policy.",
    empty_output: `The model returned no usable text before ${agentName} finished this turn.`,
    tool_errors: "A tool failed and the turn could not finish.",
    suppressed_output: `The model produced text that ${agentName} could not deliver.`,
    unknown: "The model service failed for an unknown reason.",
  } satisfies Record<ConversationTurnFailureReason, string>;
}

function failureCodeDescriptions(agentName: string) {
  return {
    delivery_failed: `${agentName} could not deliver this message.`,
    model_execution_failed: `The model stopped before ${agentName} finished this turn.`,
    persistence_failed: `${agentName} could not save the result of this turn.`,
    agent_run_failed: `${agentName} hit an internal error during this turn.`,
  } satisfies Record<ConversationTurnFailureCode, string>;
}

/** Short description for one failed turn in the transcript. */
export function transcriptFailureDescription(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
): string {
  const agentName = getDashboardAgentName();

  if (failureCode === "model_execution_failed" && failureReason) {
    return failureReasonDescriptions(agentName)[failureReason];
  }
  return failureCodeDescriptions(agentName)[failureCode];
}

/** Search text for one failed turn in the transcript. */
export function transcriptFailureSearchText(
  failureCode: ConversationTurnFailureCode,
  failureReason?: ConversationTurnFailureReason,
  eventId?: string,
): string {
  return [
    transcriptFailureTitle(failureCode, failureReason),
    transcriptFailureDescription(failureCode, failureReason),
    failureCode.replaceAll("_", " "),
    ...(failureReason ? [failureReason.replaceAll("_", " ")] : []),
    ...(eventId ? [`event_id=${eventId}`, eventId] : []),
  ].join(" ");
}
