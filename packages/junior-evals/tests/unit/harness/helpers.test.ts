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

import { serializeVisibleTranscript, slackHarness } from "../../../src/helpers";

it("includes visible Slack author names in rubric transcripts", () => {
  expect(
    JSON.parse(
      serializeVisibleTranscript({
        events: [
          {
            type: "message",
            role: "user",
            content: "I prefer risks first.",
            metadata: { author_name: "Alice Example" },
          },
          {
            type: "message",
            role: "user",
            content: "I prefer customer impact first.",
            metadata: { author_name: "Bob Example" },
          },
          {
            type: "message",
            role: "assistant",
            content: "Here is the revised draft.",
          },
        ],
      } as never),
    ),
  ).toEqual([
    {
      role: "user",
      author: "Alice Example",
      content: "I prefer risks first.",
    },
    {
      role: "user",
      author: "Bob Example",
      content: "I prefer customer impact first.",
    },
    {
      role: "assistant",
      content: "Here is the revised draft.",
    },
  ]);
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
    slackAdapter: { promptCalls: [], statusCalls: [], titleCalls: [] },
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
