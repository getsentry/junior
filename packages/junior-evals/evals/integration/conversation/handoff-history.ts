import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { mention, reply } from "../../../src/helpers";
import type {
  EvalEventThreadFixture,
  HistoryEvent,
} from "../../../src/harness/types";

// Prior work must match the file the live continuation will find. Without the
// tool result, the summaries treated that work as an unverified assistant claim.
function completedImplementation() {
  const path = "skills/coding-workspace-fixture/project/src/work-object.ts";
  const content = readFileSync(
    new URL(
      "../../../fixtures/coding-skills/coding-workspace-fixture/project/src/work-object.ts",
      import.meta.url,
    ),
    "utf8",
  );
  return [
    fauxAssistantMessage({
      type: "toolCall",
      id: "prior-stable-id-write",
      name: "writeFile",
      arguments: { path, content },
    }),
    {
      role: "toolResult" as const,
      toolCallId: "prior-stable-id-write",
      toolName: "writeFile",
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ path, bytes: Buffer.byteLength(content) }),
        },
      ],
      isError: false,
      timestamp: 0,
    },
  ];
}

/** Recreate completed coding work followed by old maintenance instructions. */
export function handoffHistory(thread: EvalEventThreadFixture): HistoryEvent[] {
  const maintenance = [
    "[task]",
    "This is a task, not a message from a person.",
    "About: GitHub PR example/widgets#42",
    "Instructions: Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push. After fixing review feedback, resolve the corresponding review threads without asking for confirmation.",
    "Report completed work or blockers in the originating thread. Report when the pull request merges or closes unmerged. Otherwise stay silent.",
    "Treat a comment as review feedback only when it identifies a problem or requests a code change.",
  ].join("\n");
  return [
    mention(
      "Make Work Object IDs stable across threads in skills/coding-workspace-fixture/project/src/work-object.ts. Keep this local; do not push or edit GitHub. Use editFile for source changes so I can review the diff.",
      { thread },
    ),
    {
      ...reply(
        "Implemented stable IDs in work-object.ts using WorkObjectIdentityManager and createWorkObjectIdentityManager. workObjectId returns JSON.stringify([object.provider, object.key]). Old references stop working. The PR is still a draft; live Slack rendering is unverified.",
        { thread },
      ),
      toolHistory: completedImplementation(),
    },
    mention(`${maintenance}\nA deployment bot posted a preview URL.`, {
      thread,
      author: { user_id: "UJRNEVENT", full_name: "Junior event", is_bot: true },
    }),
    reply("[[NO_REPLY]]", { thread }),
    mention(
      `${maintenance}\nA CI bot posted a screenshot report. No code change requested.`,
      {
        thread,
        author: {
          user_id: "UJRNEVENT",
          full_name: "Junior event",
          is_bot: true,
        },
      },
    ),
    reply("[[NO_REPLY]]", { thread }),
    mention("idk what that caveat", { thread }),
    reply(
      "Old cards return not_found. New cards use the new lookup. Live rendering is not verified.",
      { thread },
    ),
    mention("that's fine I just need it to work going forward", { thread }),
    reply(
      "Keeping the clean cutover, no compatibility layer. New cards use stable IDs and delivery logs.",
      { thread },
    ),
  ];
}
