import { AGENT_UPDATE_EVENT_TYPE } from "@sentry/junior/api/schema";

import type { TranscriptViewMessage } from "../types";
import type { LeadWorkState } from "./leadWork";

/** What a status Event of a watched Conversation says, as a state and verb. */
type WatchReport = { state: LeadWorkState; verb: string };

const done: WatchReport = { state: "done", verb: "finished" };

const reports: Record<string, WatchReport> = {
  blocked: { state: "needs_you", verb: "is blocked" },
  done,
  failed: { state: "failed", verb: "failed" },
  stopped: { state: "done", verb: "stopped" },
  waiting: { state: "needs_you", verb: "needs you" },
};

// Watch Events from before agent updates. Stored Lead transcripts keep them.
const legacyReports: Record<string, WatchReport | undefined> = {
  "conversation.completed": done,
  "conversation.failed": reports["failed"],
  "conversation.stopped": reports["stopped"],
  "conversation.waiting": reports["waiting"],
};

/** Read the status that a Watch Event of a watched Conversation reports. */
export function watchReport(
  message: TranscriptViewMessage,
): WatchReport | undefined {
  if (message.eventNamespace !== "junior" || !message.eventType) {
    return undefined;
  }
  if (message.eventType === AGENT_UPDATE_EVENT_TYPE) {
    return message.eventWatchId && message.eventStatus
      ? reports[message.eventStatus]
      : undefined;
  }
  return legacyReports[message.eventType];
}
