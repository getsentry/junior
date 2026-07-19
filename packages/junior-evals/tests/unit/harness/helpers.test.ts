import { expect, it, vi } from "vitest";

const { runError, runEvalScenarioMock } = vi.hoisted(() => ({
  runError: new Error("stop after capturing harness options"),
  runEvalScenarioMock: vi.fn(async () => {
    throw new Error("uninitialized run error");
  }),
}));

vi.mock("../../../src/behavior-harness", () => ({
  runEvalScenario: runEvalScenarioMock,
}));

import { mention, slackHarness } from "../../../src/helpers";

it("namespaces generated Slack identities across isolated modules", async () => {
  const first = mention("first");

  vi.resetModules();
  const isolated = await import("../../../src/helpers");
  const second = isolated.mention("second");

  expect(second.thread.id).not.toBe(first.thread.id);
  expect(second.thread.channel_id).not.toBe(first.thread.channel_id);
  expect(second.thread.thread_ts).not.toBe(first.thread.thread_ts);
  expect(second.message.id).not.toBe(first.message.id);
});

it("includes captured Slack posts in the rubric-visible transcript", async () => {
  runEvalScenarioMock.mockResolvedValueOnce({
    authorizationCompletions: [],
    canvases: [],
    channelPosts: [],
    conversationIds: ["slack:CEVAL:1"],
    logRecords: [],
    modelIds: ["eval-model"],
    posts: [
      {
        channel: "CEVAL",
        files: [],
        text: "Paris",
        thread_ts: "1",
      },
    ],
    reactions: [],
    sessionMessages: [
      {
        role: "user",
        content: "What is the capital of France?",
      },
    ],
    slackAdapter: { statusCalls: [] },
    toolInvocations: [],
  } as never);

  const run = await slackHarness.run(
    {
      criteria: { pass: ["Answers Paris"] },
      initialEvents: [],
      requireGatewayReady: false,
      requireSandboxReady: false,
    },
    {
      artifacts: {},
      setArtifact: vi.fn(),
      signal: new AbortController().signal,
    },
  );

  expect(run.session.events).toContainEqual(
    expect.objectContaining({
      type: "message",
      role: "assistant",
      content: "Paris",
    }),
  );
  expect(
    run.session.events.find(
      (event) => event.type === "message" && event.role === "assistant",
    )?.metadata,
  ).not.toHaveProperty("rubric_visible", false);
});

it("forwards the Vitest abort signal to the eval scenario", async () => {
  runEvalScenarioMock.mockRejectedValueOnce(runError);
  const controller = new AbortController();

  await expect(
    slackHarness.run(
      { criteria: { pass: [] }, initialEvents: [] },
      {
        artifacts: {},
        setArtifact: vi.fn(),
        signal: controller.signal,
      },
    ),
  ).rejects.toBe(runError);

  expect(runEvalScenarioMock).toHaveBeenCalledWith(
    { initialEvents: [], events: undefined, overrides: undefined },
    { logRecords: [], signal: controller.signal },
  );
});
