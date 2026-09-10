import { expect, it, vi } from "vitest";

const { completeTextMock, runError, runEvalScenarioMock } = vi.hoisted(() => ({
  completeTextMock: vi.fn(),
  runError: new Error("stop after capturing harness options"),
  runEvalScenarioMock: vi.fn(async () => {
    throw new Error("uninitialized run error");
  }),
}));

vi.mock("@/chat/pi/client", () => ({
  completeText: completeTextMock,
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  resolveGatewayModel: vi.fn((modelId: string) => ({ id: modelId })),
}));

vi.mock("../../../src/behavior-harness", () => ({
  runEvalScenario: runEvalScenarioMock,
}));

import {
  hasImageAttachment,
  RubricJudge,
  serializeVisibleTranscript,
  slackEvals,
  slackHarness,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../../src/helpers";

it("selects visible assistant text and image attachments without assertions", () => {
  const session = {
    events: [
      {
        type: "message",
        role: "assistant",
        content: "Shared it.",
        metadata: {
          event_type: "thread_post",
          files: [{ filename: "result.png", isImage: true }],
        },
      },
      {
        type: "message",
        role: "assistant",
        content: { type: "reaction_added", emoji: "heart" },
        metadata: { event_type: "reaction_added" },
      },
    ],
  } as never;

  expect(visibleThreadReplies(session)).toHaveLength(1);
  expect(visibleAssistantText(session)).toBe("Shared it.\n");
  expect(hasImageAttachment(session)).toBe(true);
});

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

it("records rubric judge cost in score metadata", async () => {
  completeTextMock.mockResolvedValueOnce({
    message: {
      usage: { cost: { total: 0.031 } },
    },
    text: '{"answer":"A","rationale":"The response meets the rubric."}',
  });

  const judgeRun = await slackEvals.judgeHarness.run(
    { prompt: "Grade this.", system: "Return JSON." },
    { artifacts: {}, setArtifact: vi.fn() },
  );
  const result = await RubricJudge.assess({
    harness: slackHarness,
    input: { criteria: { pass: ["Answers correctly"] }, initialEvents: [] },
    output: undefined,
    run: {} as never,
    runJudge: async () => judgeRun.output,
    session: { events: [] },
    toolCalls: [],
  });

  expect(result.metadata).toMatchObject({ answer: "A", costUsd: 0.031 });
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
