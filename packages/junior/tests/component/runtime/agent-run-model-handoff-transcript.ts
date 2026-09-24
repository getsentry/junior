import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";

// Reduced from a production failure. Names and resource identifiers are synthetic.
// Keep the old automation instructions, silent replies, and newer human request.
const maintenance = [
  "[task]",
  "This is a task, not a message from a person.",
  "About: GitHub PR example/widgets#42",
  "Instructions: Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push.",
  "Report completed work or blockers in the originating thread. Report when the pull request merges or closes unmerged. Otherwise stay silent.",
].join("\n");

/** Reproduce the completed turns before an immediate handoff on a cleanup request. */
export function handoffMaintenanceTranscript(): PiMessage[] {
  const user = (text: string, timestamp: number): PiMessage => ({
    role: "user",
    content: [{ type: "text", text: renderCurrentInstruction(text) }],
    timestamp,
  });
  return [
    user(
      "Fix the Work Object implementation to match the docs, and log when we attach one. Leave the unfurl flags alone.",
      1,
    ),
    fauxAssistantMessage(
      "Opened draft PR example/widgets#42 on fix/work-object-contract. New cards use stable IDs and delivery logs. Tests and typecheck pass. Old annotation detail references return not_found after this change.",
      { timestamp: 2 },
    ),
    user(
      `${maintenance}\nTrusted summary: A deployment bot posted a preview link. Deployment is building.`,
      3,
    ),
    fauxAssistantMessage("[[NO_REPLY]]", { timestamp: 4 }),
    user(
      `${maintenance}\nTrusted summary: A CI bot posted a screenshot report. One screenshot changed. No code change requested.`,
      5,
    ),
    fauxAssistantMessage("[[NO_REPLY]]", { timestamp: 6 }),
    user("What does that caveat mean?", 7),
    fauxAssistantMessage(
      "Old cards will return not_found. New cards use the new lookup. Live rendering is not verified.",
      { timestamp: 8 },
    ),
    user("That's fine. I just need it to work going forward.", 9),
    fauxAssistantMessage(
      "Keeping the clean cutover, no compatibility layer. New cards use stable IDs; delivery logs will help diagnose rendering failures.",
      { timestamp: 10 },
    ),
  ];
}

// Replay the observed summarizer error, not a corrected summary. The runtime
// must keep the active instruction even when the model selects an older task.
export const maintenanceHandoffSummary = [
  "## Task",
  "Maintain Junior-created GitHub PR example/widgets#42 and respond only to actionable review feedback or failed checks. Otherwise stay silent.",
  "",
  "## User preference",
  "The user asked to Deslop PR #42. They accepted the clean cutover without backward compatibility. Do not revisit unfurl_links.",
  "",
  "## Current PR state",
  "Draft PR example/widgets#42 on fix/work-object-contract. Stable object IDs and delivery logs are implemented. Tests and typecheck pass.",
  "",
  "## Review/event history",
  "The deployment status and screenshot report were not actionable. No review thread was resolved.",
  "",
  "## Next steps",
  "For any new PR event, inspect whether it is actionable review feedback or a failed check. If actionable, make a scoped fix, verify it, push, and report. Otherwise remain silent.",
].join("\n");
