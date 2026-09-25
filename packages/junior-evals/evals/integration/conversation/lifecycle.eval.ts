import { describeEval, toolCalls } from "vitest-evals";
import { expect, vi } from "vitest";
import { getConversationStore } from "@/chat/db";
import { handoffHistory } from "./handoff-history";
import {
  conversationIds,
  mention,
  rubric,
  slackEvals,
  slackSideEffects,
  threadStart,
  visibleThreadReplies,
} from "../../../src/helpers";

describeEval("Lifecycle and Resilience", slackEvals, (it) => {
  it("when an assistant thread starts, set the default title and prompts without posting a reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadStart()],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(0);
    expect(slackSideEffects(result)).toMatchObject({
      suggestedPromptCalls: 1,
      threadTitleCalls: 1,
      threadTitles: ["Junior"],
    });
  });

  it("when the first human message lands, store a non-default conversation title", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("How do I debug a Node.js memory leak in production?"),
      ],
      requireSandboxReady: false,
    });

    const ids = conversationIds(result);
    expect(ids.length).toBeGreaterThan(0);

    // Title generation is detached from reply delivery, so wait briefly for the
    // automatic persist path to finish after the first human message.
    await vi.waitFor(async () => {
      const stored = await getConversationStore().get({
        conversationId: ids[0]!,
      });
      const title = stored?.title?.trim() ?? "";
      expect(title.length).toBeGreaterThan(0);
      expect(title).not.toBe("Junior");
    });
  });

  it("when a tool call is interrupted at a turn deadline, continue the task to completion", async ({
    run,
  }) => {
    // The first release push lands remotely but stalls past the turn deadline.
    // The runtime records the interrupted call and resumes the turn.
    const pushTool = "mcp__eval-operation__release-push";
    const statusTool = "mcp__eval-operation__release-status";
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/plugins"],
        turn_timeout_ms: 25_000,
      },
      initialEvents: [
        mention(
          "/eval-operation Ship the release and tell me the final remote status.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The final reply reports that the remote release status is shipped.",
          "The assistant continues after the interrupted push and bases the answer on the observed remote state.",
        ],
        fail: [
          "The reply only reports that the work was interrupted or timed out.",
          "The assistant asks the user to retry instead of completing the task.",
        ],
      }),
    });

    const calls = toolCalls(result.session);
    const pushCalls = calls.filter(
      (call) =>
        call.name === "callMcpTool" && call.arguments?.tool_name === pushTool,
    );
    // The runtime reports the preempted push as an attempt with unknown
    // outcome and resumes the turn. Whether the agent verifies remote state
    // before pushing again is model judgment, measured by the rubric.
    expect(pushCalls[0]).toMatchObject({
      status: "ok",
      result: { aborted: true },
    });
    expect(calls).toContainEqual(
      expect.objectContaining({
        name: "callMcpTool",
        status: "ok",
        arguments: expect.objectContaining({ tool_name: statusTool }),
      }),
    );
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when handoff follows old PR events, finish the new cleanup request", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("Deslop")],
      overrides: { handoff: { history: handoffHistory() } },
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The reply supplies a rewritten PR title and description in plain language, rather than merely promising a rewrite.",
          "The rewrite describes stable Work Object IDs across threads and delivery logs. It preserves the accepted break for old references and says live Slack rendering remains unverified.",
        ],
        fail: [
          "The assistant waits for new PR events, says there is nothing to do, or asks what Deslop means.",
          "The assistant only reports a summary, plan, or handoff instead of providing the rewritten copy.",
          "The assistant claims to have edited GitHub or verified live rendering.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toContainEqual(
      expect.objectContaining({ name: "handoff", status: "ok" }),
    );
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });

  it("when active history is compacted, continue the unfinished task", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        active_turn_compaction: {
          summary:
            "The deployment diagnostic completed successfully. Checking and reporting the current UTC time remain unfinished.",
        },
      },
      initialEvents: [
        mention(
          "After the deployment diagnostic finishes, tell me the current UTC time. Wait until you've checked it before answering.",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant checks and reports the current time in UTC after continuing from the completed diagnostic.",
        ],
        fail: [
          "The reply only gives a plan, checkpoint summary, or promise to check the time later.",
          "The assistant repeats the completed diagnostic instead of finishing the remaining request.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toContainEqual(
      expect.objectContaining({ name: "systemTime", status: "ok" }),
    );
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
