import { mention, reply } from "../../../src/helpers";
import type {
  EvalEventThreadFixture,
  HistoryEvent,
} from "../../../src/harness/types";

/** Recreate prior PR discussion with synthetic names and a copy-only task. */
export function handoffHistory(thread: EvalEventThreadFixture): HistoryEvent[] {
  const maintenance = [
    "[task]",
    "This is a task, not a message from a person.",
    "About: GitHub PR example/widgets#42",
    "Instructions: Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push.",
    "Report completed work or blockers in the originating thread. Report when the pull request merges or closes unmerged. Otherwise stay silent.",
  ].join("\n");
  return [
    mention(
      "Draft the title and description here for PR #42. Don't edit GitHub. The patch makes Work Object IDs stable across threads and adds delivery logs. Old references stop working. Tests pass, but live Slack rendering is unverified. When I say deslop, rewrite the draft in plain language without changing those facts.",
      { thread },
    ),
    reply(
      "Title: Operationalize cross-conversation Work Object identity stabilization and delivery observability\n\nDescription: This change leverages canonical identity semantics to facilitate consistent cross-thread object reference resolution. It adds delivery observability instrumentation. Legacy references cease resolution after cutover. Automated verification passes; live Slack rendering is unverified.",
      { thread },
    ),
    mention(`${maintenance}\nA deployment bot posted a preview URL.`, {
      thread,
    }),
    reply("[[NO_REPLY]]", { thread }),
    mention(
      `${maintenance}\nA CI bot posted a screenshot report. No code change requested.`,
      { thread },
    ),
    reply("[[NO_REPLY]]", { thread }),
    mention("What does that caveat mean?", { thread }),
    reply(
      "Old cards return not_found. New cards use the new lookup. Live rendering is not verified.",
      { thread },
    ),
    mention("That's fine. I just need it to work going forward.", { thread }),
    reply(
      "Keeping the clean cutover, no compatibility layer. New cards use stable IDs and delivery logs.",
      { thread },
    ),
  ];
}
