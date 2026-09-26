import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { handoffHistory } from "./handoff-history";
import {
  clearMemories,
  memoryPluginOverrides,
  seedMemory,
} from "../../memory/helpers";
import { lastTurnReplies, mention, slackEvals } from "../../../src/helpers";

// Memory defines the terse request. Prior work is complete, so the continuation
// must act on the new request rather than repeat old work. Both cases use live
// handoff and summarization; only the cleanup request differs.
describeEval("Handoff task continuity", slackEvals, (it) => {
  for (const [label, instruction] of [
    ["terse request", "Deslop"],
    [
      "explicit request control",
      "Simplify work-object.ts: remove the unnecessary class and factory while keeping workObjectId and its stable ID behavior. Keep the change local.",
    ],
  ] as const) {
    it(`finishes the cleanup after handoff: ${label}`, async ({ run }) => {
      const thread = {
        channel_type: "channel" as const,
        id: "thread-handoff-cleanup",
        channel_id: "CHANDOFFCLEANUP",
        thread_ts: "17000000.004200",
      };
      await clearMemories();
      await seedMemory({
        content:
          "Deslop means cleaning the entire changeset: code, tests, comments, commit artifacts, pull-request title, and pull-request description. Remove jargon, follow repository terminology and practices, delete overbuilt or duplicate work, and keep the smallest clear patch.",
        idempotencyKey: "handoff-deslop-meaning",
        kind: "procedure",
        subject: "conversation",
        thread,
      });
      const result = await run({
        history: handoffHistory(thread),
        initialEvents: [
          mention(
            `Switch to the other configured profile first. ${instruction}`,
            {
              thread,
            },
          ),
        ],
        overrides: {
          ...memoryPluginOverrides,
          skill_dirs: ["fixtures/coding-skills"],
        },
      });

      const calls = toolCalls(result.session);
      const handoffIndex = calls.findIndex(
        (call) => call.name === "handoff" && call.status === "ok",
      );
      expect(
        handoffIndex,
        "No handoff: this run does not test task loss",
      ).toBeGreaterThanOrEqual(0);
      const edits = calls
        .slice(handoffIndex + 1)
        .filter(
          (call) =>
            call.name === "editFile" &&
            call.status === "ok" &&
            typeof call.arguments?.path === "string" &&
            call.arguments.path.endsWith("project/src/work-object.ts"),
        );
      expect(
        edits,
        "The original cleanup needs a successful source edit after handoff",
      ).not.toHaveLength(0);
      const diffs = edits
        .map((call) =>
          call.status === "ok"
            ? ((call.result as { diff?: string } | undefined)?.diff ?? "")
            : "",
        )
        .join("\n");
      expect(diffs).toMatch(/-.*class WorkObjectIdentityManager/);
      expect(diffs).toMatch(/-.*function createWorkObjectIdentityManager/);
      expect(lastTurnReplies(result.session).length).toBeGreaterThan(0);
    });
  }
});
