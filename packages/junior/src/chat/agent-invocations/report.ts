/**
 * How a child agent Run reports to its parent. A child's final response is
 * not sent to the parent. Only `messageAgent` to `parent` reaches it, or the
 * Run ends with `noReply` or `reportBlocked`. `sendReportToParent` saves each
 * report in the report log. A Run that ended with a final response, without
 * a report for its latest task, `noReply`, or `reportBlocked`, gets one
 * reminder from the reply gate.
 */
import { readNoReply, type NoReply } from "@/chat/no-reply";
import { readBlockedReport } from "./blocked-report";
import {
  MESSAGE_AGENT_TEXT_MAX_LENGTH,
  type AgentInvocationReportEntry,
} from "./types";

/** Model-facing tool that a child agent reports with. */
export const MESSAGE_AGENT_TOOL_NAME = "messageAgent";

/** Longest output of one `<agent-result>`. */
export const AGENT_INVOCATION_RESULT_MAX_LENGTH = 12_000;

// The child agent rules own the reporting rule. This only points to it.
export const CHILD_REPORT_REMINDER =
  "No report for your latest task was sent. Report as your child agent rules say: send it now with `messageAgent` to `parent`, or end the run with `noReply`.";

/** Result of a parent task whose child agent ended without a report. */
const NO_REPORT_RESULT =
  "The child agent ended without sending a report, so no report was delivered. Its unsent text is not shown. Use messageAgent to ask it for its report.";

/** Result end of a parent task with no report for the task that steered it last. */
const NO_LATEST_REPORT_RESULT =
  "The child agent sent no report for its latest task. Its unsent text is not shown. Use messageAgent to ask it for that report.";

/** Result of a parent task whose child agent chose `noReply` with no note. */
const NO_REPLY_RESULT = "The child agent finished and sent no report.";

type ReportEntries = readonly AgentInvocationReportEntry[] | undefined;

/** Return the texts of the reports, in order. */
export function reportTexts(entries: ReportEntries): string[] {
  return (entries ?? []).flatMap((entry) =>
    entry.kind === "report" && entry.text ? [entry.text] : [],
  );
}

/**
 * Return whether a report came after the last parent task that steered the
 * Run. With no steering, any report counts.
 */
export function hasReportForLatestTask(entries: ReportEntries): boolean {
  let reported = false;
  for (const entry of entries ?? []) {
    reported =
      entry.kind === "report" || (reported && entry.kind !== "steered_task");
  }
  return reported;
}

/**
 * Return the id of the latest parent task that steered the Run, or `first`
 * for the task that started it. The reply gate reminds once per task.
 */
export function latestTaskId(entries: ReportEntries): string {
  let taskId = "first";
  for (const entry of entries ?? []) {
    if (entry.kind === "steered_task") taskId = entry.invocationId;
  }
  return taskId;
}

/**
 * Join a head, the reports, and a tail within the result cap. Earlier reports
 * are cut first, behind a marker, so the last report stays whole.
 */
function fitReports(
  head: string | undefined,
  reports: readonly string[],
  tail?: string,
): string {
  let kept = [...reports];
  let cut = 0;
  const render = () =>
    [
      head,
      cut > 0
        ? `[${cut} earlier ${cut === 1 ? "report was" : "reports were"} cut to fit.]`
        : undefined,
      ...kept,
      tail,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
  while (
    kept.length > 1 &&
    render().length > AGENT_INVOCATION_RESULT_MAX_LENGTH
  ) {
    kept = kept.slice(1);
    cut += 1;
  }
  return render();
}

/**
 * Trim a report that does not come from `messageAgent`, and cap it like a
 * `messageAgent` text.
 */
export function capReport(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed && trimmed.length > MESSAGE_AGENT_TEXT_MAX_LENGTH
    ? `${trimmed.slice(0, MESSAGE_AGENT_TEXT_MAX_LENGTH - 1)}…`
    : trimmed || undefined;
}

/**
 * Add the closing report of a parent task, such as a `noReply` note. A
 * `noReply` end adds it even with no note, so the latest task counts as
 * answered. It is capped like a `messageAgent` report.
 */
export function appendClosingReport(
  entries: ReportEntries,
  closingReport: string | undefined,
  options: { noReply: boolean },
): AgentInvocationReportEntry[] {
  const text = capReport(closingReport);
  return [
    ...(entries ?? []),
    ...(text || options.noReply
      ? [{ key: "closing", kind: "report" as const, text: text ?? "" }]
      : []),
  ];
}

/**
 * Return the result of a finished parent task: its reports, then a note when
 * its latest task got none.
 */
export function renderTaskResult(all: ReportEntries): string {
  const reports = reportTexts(all);
  const answered = hasReportForLatestTask(all);
  if (reports.length === 0) {
    return answered ? NO_REPLY_RESULT : NO_REPORT_RESULT;
  }
  return fitReports(
    undefined,
    reports,
    answered ? undefined : NO_LATEST_REPORT_RESULT,
  );
}

/**
 * Return the error output of a parent task that did not complete, with the
 * reports that it already sent after the error.
 */
export function renderTaskError(
  errorMessage: string,
  entries: ReportEntries,
): string {
  const reports = reportTexts(entries);
  return reports.length === 0
    ? errorMessage
    : fitReports(`${errorMessage}\n\nReports sent before this:`, reports);
}

/**
 * Return how one finished child agent Turn ends. Pass `errorMessage` when the
 * Turn failed, and the messages of this Turn. `noReply` and `reportBlocked`
 * end the Turn, so they are its last messages. The saved reports become the
 * output when the Agent invocation completes.
 */
export function childTurnOutcome(args: {
  errorMessage?: string;
  turnMessages: readonly unknown[];
}):
  | { errorMessage: string; status: "blocked" | "failed" }
  | { noReply?: NoReply; status: "completed" } {
  if (args.errorMessage !== undefined) {
    return { errorMessage: args.errorMessage, status: "failed" };
  }
  const blocked = readBlockedReport(args.turnMessages);
  if (blocked) {
    return { errorMessage: blocked.missing, status: "blocked" };
  }
  const noReply = readNoReply(args.turnMessages);
  return { ...(noReply ? { noReply } : undefined), status: "completed" };
}

/**
 * Return the messages of one Turn. A Turn record without a start index cannot
 * tell this Turn from earlier history of a named child, so it gives none.
 */
export function turnMessages(
  messages: readonly unknown[],
  turnStartMessageIndex: number | undefined,
): readonly unknown[] {
  return turnStartMessageIndex === undefined
    ? []
    : messages.slice(turnStartMessageIndex);
}
