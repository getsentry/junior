import { capReport } from "./report";
import { appendAgentInvocationReport, isParentTask } from "./store";
import type { AgentInvocation } from "./types";

/** Sends one `<agent-message>` from a child agent to its parent. */
export type EnqueueAgentMessage = (
  sender: AgentInvocation,
  messageKey: string,
  text: string,
) => Promise<void>;

/**
 * Send one report from a child agent to its parent. `messageAgent` to
 * `parent` and a turn-limit stop both send through here. The report log
 * keeps the report first, so a later yield, compaction, or failure does not
 * lose it. A parent task gets its reports in one result when the Run ends,
 * so the parent wakes once per task. Own work sends each report now as an
 * `<agent-message>`. A repeat with the same `key` is not saved or sent twice.
 */
export async function sendReportToParent(args: {
  enqueueMessage?: EnqueueAgentMessage;
  invocation: AgentInvocation;
  key: string;
  text: string;
}): Promise<void> {
  const text = capReport(args.text);
  if (!text) {
    return;
  }
  await appendAgentInvocationReport(args.invocation.invocationId, {
    key: args.key,
    kind: "report",
    text,
  });
  if (!isParentTask(args.invocation)) {
    await args.enqueueMessage?.(args.invocation, args.key, text);
  }
}
