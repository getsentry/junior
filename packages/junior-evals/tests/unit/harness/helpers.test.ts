import { expect, it, vi } from "vitest";
import { getHarnessRunFromError, toolCalls } from "vitest-evals/harness";

const { runError, runEvalScenarioMock } = vi.hoisted(() => ({
  runError: new Error("stop after capturing harness options"),
  runEvalScenarioMock: vi.fn(async () => {
    throw new Error("uninitialized run error");
  }),
}));

vi.mock("../../../src/behavior-harness", () => ({
  runEvalScenario: runEvalScenarioMock,
}));

import {
  hasImageAttachment,
  serializeVisibleTranscript,
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
        content: "",
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

  expect(visibleThreadReplies(session)).toHaveLength(0);
  expect(visibleAssistantText(session)).toBe("\n");
  expect(JSON.parse(serializeVisibleTranscript(session))).toEqual([
    { role: "assistant", content: "[attached image: result.png]" },
  ]);
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

it("preserves Slack posts and tool outcomes in the normalized session", async () => {
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
    toolInvocations: [
      { tool: "readFile", completed: true, result: { content: "Paris" } },
      { tool: "webFetch", completed: true, error: "HTTP 503" },
      { tool: "listDir", arguments: { path: "/vercel/sandbox" } },
    ],
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
  expect(toolCalls(run.session)).toMatchObject([
    { name: "readFile", status: "ok", result: { content: "Paris" } },
    { name: "webFetch", status: "error", error: { message: "HTTP 503" } },
    {
      name: "listDir",
      status: "pending",
      arguments: { path: "/vercel/sandbox" },
    },
  ]);
  expect(JSON.parse(serializeVisibleTranscript(run.session))).toEqual([
    { role: "user", content: "What is the capital of France?" },
    { role: "assistant", content: "Paris" },
  ]);
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

it("keeps the transcript when post-run status validation fails", async () => {
  runEvalScenarioMock.mockResolvedValueOnce({
    authorizationCompletions: [],
    canvases: [],
    channelPosts: [],
    conversationIds: [],
    logRecords: [],
    modelIds: [],
    posts: [],
    reactions: [],
    sessionMessages: [{ role: "assistant", content: "Finished" }],
    slackAdapter: {
      promptCalls: [],
      titleCalls: [],
      statusCalls: [{ channelId: "CEVAL", threadTs: "1", text: "Working" }],
    },
    toolInvocations: [],
  } as never);
  const error = await slackHarness
    .run({ initialEvents: [] }, { artifacts: {}, setArtifact: vi.fn() })
    .catch((error) => error);
  expect(error.message).toContain("status pending");
  expect(getHarnessRunFromError(error)?.session.events).toContainEqual(
    expect.objectContaining({ content: "Finished" }),
  );
});
