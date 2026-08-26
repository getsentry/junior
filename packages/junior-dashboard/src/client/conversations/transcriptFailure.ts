import type { ConversationTurnFailureCode } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";

/** Title for one failed turn in the transcript. */
export function transcriptFailureTitle(
  failureCode: ConversationTurnFailureCode,
): string {
  switch (failureCode) {
    case "delivery_failed":
      return "Message delivery failed";
    case "model_execution_failed":
      return "Model execution failed";
    case "persistence_failed":
      return "Save failed";
    case "agent_run_failed":
      return "Agent run failed";
  }
}

/** Short description for one failed turn in the transcript. */
export function transcriptFailureDescription(
  failureCode: ConversationTurnFailureCode,
): string {
  const agentName = getDashboardAgentName();
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
}

/** Search text for one failed turn in the transcript. */
export function transcriptFailureSearchText(
  failureCode: ConversationTurnFailureCode,
): string {
  return [
    transcriptFailureTitle(failureCode),
    transcriptFailureDescription(failureCode),
    failureCode.replaceAll("_", " "),
    failureCode,
  ].join(" ");
}
