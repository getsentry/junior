import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  agentSteps,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

const codingFixtureOverrides = {
  skill_dirs: ["fixtures/coding-skills"],
};

describeEval("Coding File Tools", slackEvals, (it) => {
  it("when making a targeted source edit, update the value and report the changed path", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "In the eval coding fixture, change the default retry count from 2 to 3. Keep the reply brief and tell me which file changed.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The final reply identifies the changed config file and says the default retry count is now 3.",
        ],
        fail: [
          "Do not answer with only a plan or promise to edit later.",
          "Do not report a file unrelated to the retry-count setting as the changed file.",
        ],
      }),
    });
  });

  it("when comparing fixture behavior, cite the relevant files and leave them unchanged", async ({
    run,
  }) => {
    await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "In the eval coding fixture, compare project/src/alerts.ts and project/docs/operations.md for emergency mode behavior. Summarize what each file says and do not change any files.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply cites the alert source file and the operations doc using recognizable fixture-relative paths.",
          "The reply accurately summarizes that source code handles emergency alerts while the operations doc describes escalation or operator behavior.",
          "The reply does not claim that any fixture files were modified.",
        ],
        fail: [
          "Do not say that files were changed for this read-only request.",
          "Do not answer with generic emergency-mode advice instead of fixture file evidence.",
          "Do not report unrelated files as the only evidence.",
        ],
      }),
    });
  });

  it("when a coding request requires architecture reasoning, upgrade before analysis", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "I have a TypeScript worker where config.ts defines emergencyMode, but alerts.ts currently receives a mode argument independently. Before we implement anything, recommend whether alerts should import runtime config directly or keep mode as an explicit dependency, and give me the test strategy. Use only this description; no repository inspection is needed.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply makes a concrete recommendation about direct config access versus explicit dependency injection.",
          "The reply explains the architectural tradeoff and gives a focused test strategy.",
        ],
        fail: [
          "Do not claim repository files were inspected or changed.",
          "Do not answer with only a promise to analyze later.",
        ],
      }),
    });
    expect(toolCalls(result.session)[0]).toMatchObject({ name: "handoff" });
  });

  it("hands a coding task to the handoff projection and keeps that model and workspace on the next turn", async ({
    run,
  }) => {
    const thread = {
      id: "thread-model-handoff",
      channel_id: "CMODELHANDOFF",
      thread_ts: "17000000.5400",
    };
    const result = await run({
      overrides: codingFixtureOverrides,
      initialEvents: [
        mention(
          "In the eval coding fixture, create skills/coding-workspace-fixture/project/handoff-proof.txt containing exactly `projection-cobalt-7319`, read it back, and report its exact contents.",
          { thread },
        ),
      ],
      events: [
        threadMessage(
          "Without rewriting it, run sha256sum on skills/coding-workspace-fixture/project/handoff-proof.txt and report the exact digest.",
          { thread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant completes both turns; the first reply reports projection-cobalt-7319 and the second reports SHA-256 digest 2613e9a4578bc3a4de57451d7e553efcbce5df5002ca77628a962dc660804082.",
          "The second turn hashes the file created in the first turn from the same workspace without rewriting it.",
        ],
        fail: [
          "Do not answer with only a plan or promise to inspect the file later.",
          "Do not report sandbox setup failure text.",
        ],
      }),
    });

    const calls = toolCalls(result.session);
    expect(calls[0]).toMatchObject({
      name: "handoff",
      arguments: { profile: "coding" },
    });
    expect(calls.filter((call) => call.name === "handoff")).toHaveLength(1);

    const steps = await agentSteps(result.session);
    const markers = steps.filter(
      (step) =>
        step.entry.type === "context_epoch_started" &&
        step.entry.reason === "handoff",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.entry).toMatchObject({
      type: "context_epoch_started",
      reason: "handoff",
      modelProfile: "coding",
    });

    const replies = assistantMessages(result.session).filter(
      (message) => message.metadata?.event_type === "thread_post",
    );
    expect(replies).toHaveLength(2);
    expect(
      calls.some((call) => {
        const args = JSON.stringify(call.arguments) ?? "";
        return args.includes("sha256sum") && args.includes("handoff-proof.txt");
      }),
    ).toBe(true);
    const followUp = steps.find(
      (step) =>
        step.entry.type === "pi_message" &&
        step.role === "user" &&
        JSON.stringify(step.entry.message).includes(
          "run sha256sum on skills/coding-workspace-fixture/project/handoff-proof.txt",
        ),
    );
    expect(followUp).toBeDefined();
    const firstHandoffModels = steps
      .filter(
        (step) =>
          step.seq > markers[0]!.seq &&
          step.seq < followUp!.seq &&
          step.entry.type === "pi_message" &&
          step.role === "assistant",
      )
      .map((step) =>
        step.entry.type === "pi_message" &&
        step.entry.message.role === "assistant"
          ? step.entry.message.model
          : undefined,
      );
    const handoffModel = firstHandoffModels.at(-1);
    expect(handoffModel).toBeDefined();
    expect(handoffModel).not.toBe(process.env.AI_MODEL);
    const followUpModels = steps
      .filter(
        (step) =>
          step.seq > followUp!.seq &&
          step.entry.type === "pi_message" &&
          step.role === "assistant",
      )
      .map((step) =>
        step.entry.type === "pi_message" &&
        step.entry.message.role === "assistant"
          ? step.entry.message.model
          : undefined,
      );
    expect(followUpModels.length).toBeGreaterThan(0);
    expect(followUpModels).toEqual(followUpModels.map(() => handoffModel));
  });
});
