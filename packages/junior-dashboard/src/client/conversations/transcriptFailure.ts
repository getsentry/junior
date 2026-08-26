import { getDashboardAgentName } from "../agentName";

/** Stable privacy-safe failure codes shown in the conversation transcript. */
export type TranscriptFailureCode =
  | "agent_run_failed"
  | "delivery_failed"
  | "model_execution_failed"
  | "persistence_failed";

/** Human title for one terminal transcript failure. */
export function transcriptFailureTitle(failureCode: TranscriptFailureCode): string {
  switch (failureCode) {
    case "delivery_failed":
      return "Message delivery failed";
    case "model_execution_failed":
      return "Model execution failed";
    case "persistence_failed":
      return "Persistence failed";
    case "agent_run_failed":
      return "Agent run failed";
  }
}

/** Human description for one terminal transcript failure. */
export function transcriptFailureDescription(
  failureCode: TranscriptFailureCode,
): string {
  const agentName = getDashboardAgentName();
  switch (failureCode) {
    case "delivery_failed":
      return `${agentName} could not deliver this message to its destination.`;
    case "model_execution_failed":
      return `The model response ended before ${agentName} could complete this turn.`;
    case "persistence_failed":
      return `${agentName} could not persist the result of this turn.`;
    case "agent_run_failed":
      return `${agentName} hit an internal error while running this turn.`;
  }
}

/** Searchable plain text for one terminal transcript failure. */
export function transcriptFailureSearchText(
  failureCode: TranscriptFailureCode,
): string {
  return [
    transcriptFailureTitle(failureCode),
    transcriptFailureDescription(failureCode),
    failureCode.replaceAll("_", " "),
    failureCode,
  ].join(" ");
}
