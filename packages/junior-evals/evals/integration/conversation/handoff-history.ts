import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";

/** Reduced production sequence with a self-contained PR-copy cleanup task. */
export function handoffHistory(): PiMessage[] {
  const user = (text: string, timestamp: number): PiMessage => ({
    role: "user",
    content: [{ type: "text", text: renderCurrentInstruction(text) }],
    timestamp,
  });
  const maintenance = [
    "[task]",
    "This is a task, not a message from a person.",
    "About: GitHub PR example/widgets#42",
    "Instructions: Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push.",
    "Report completed work or blockers in the originating thread. Report when the pull request merges or closes unmerged. Otherwise stay silent.",
  ].join("\n");
  return [
    user(
      "Draft the title and description here for PR #42. Don't edit GitHub. The patch makes Work Object IDs stable across threads and adds delivery logs. Old references stop working. Tests pass, but live Slack rendering is unverified. When I say deslop, rewrite the draft in plain language without changing those facts.",
      1,
    ),
    fauxAssistantMessage(
      "Title: Operationalize cross-conversation Work Object identity stabilization and delivery observability\n\nDescription: This change leverages canonical identity semantics to facilitate consistent cross-thread object reference resolution. It adds delivery observability instrumentation. Legacy references cease resolution after cutover. Automated verification passes; live Slack rendering is unverified.",
      { timestamp: 2 },
    ),
    user(`${maintenance}\nA deployment bot posted a preview URL.`, 3),
    fauxAssistantMessage("[[NO_REPLY]]", { timestamp: 4 }),
    user(
      `${maintenance}\nA CI bot posted a screenshot report. No code change requested.`,
      5,
    ),
    fauxAssistantMessage("[[NO_REPLY]]", { timestamp: 6 }),
    user("What does that caveat mean?", 7),
    fauxAssistantMessage(
      "Old cards return not_found. New cards use the new lookup. Live rendering is not verified.",
      { timestamp: 8 },
    ),
    user("That's fine. I just need it to work going forward.", 9),
    fauxAssistantMessage(
      "Keeping the clean cutover, no compatibility layer. New cards use stable IDs and delivery logs.",
      { timestamp: 10 },
    ),
  ];
}
