/**
 * What an Automation run posts and how its dispatch ends.
 *
 * A Scheduled automation or Event automation run ends its dispatch Turn with
 * one answer. The run does not deliver its final response. The work owner
 * reads the answer and applies the stored outcomes.
 */
import type { Reply } from "@/chat/turn-answer";
import type { BlockedReport } from "@/chat/agent-invocations/blocked-report";

/** Dispatch facts that decide what a run posts. */
export type RunDispatch =
  | { declaresResult?: boolean; outcomes?: readonly unknown[] }
  | undefined;

/**
 * Return the text to post after a run ends, if any. A chat Turn already
 * delivered a successful reply, so it posts only its failure reply. An
 * Automation run posts only a declared message. It never posts a failure
 * reply to its outcomes. The failed execution shows on the Automation.
 */
export function finishedRunReply(
  result: {
    reply?: Reply;
    diagnostics: { outcome: string };
    text: string;
  },
  dispatch: RunDispatch,
): string | undefined {
  if (!dispatch?.declaresResult) {
    return result.diagnostics.outcome === "success" ? undefined : result.text;
  }
  return result.diagnostics.outcome === "success" &&
    dispatch.outcomes?.length !== 0
    ? result.reply?.text
    : undefined;
}

/**
 * Map one finished agent run to its dispatch outcome. A blocked report
 * becomes a blocked dispatch with the reported reason.
 */
export function runDispatchOutcome(result: {
  blocked?: BlockedReport;
  diagnostics: { errorMessage?: string; outcome: string };
}): { errorMessage?: string; outcome: "blocked" | "completed" | "failed" } {
  if (result.diagnostics.outcome !== "success") {
    return {
      errorMessage:
        result.diagnostics.errorMessage ??
        `Agent turn ended with ${result.diagnostics.outcome}.`,
      outcome: "failed",
    };
  }
  if (result.blocked) {
    return { errorMessage: result.blocked.missing, outcome: "blocked" };
  }
  return { outcome: "completed" };
}
