import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  mockAnthropicStream,
  withoutCacheMarkers,
} from "../fixtures/anthropic-stream";
import { botConfig } from "@/chat/config";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";
import { createWorkspace, deleteWorkspace } from "@/chat/workspaces/store";
import { installTestSkills } from "../fixtures/skill-dirs";
import { mockTitleModel } from "../fixtures/title-model";

const originalBotConfig = { ...botConfig };

describe("model message history", () => {
  afterEach(async () => {
    Object.assign(botConfig, originalBotConfig);
    await closeConversationFixture();
  });
  it("preserves native messages and provider request prefixes across Turns", async () => {
    const toolArguments = {
      explanation: "Check the result\u0000before replying.",
      plan: [
        { status: "in_progress", step: "Check the result" },
        { status: "pending", step: "Reply to the user" },
      ],
    };
    mockTitleModel("Conversation title");
    const requests = mockAnthropicStream("openai/gpt-6-astra", [
      [
        {
          type: "thinking",
          thinking: "Check the plan.",
          signature: "opaque-signature",
        },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        {
          type: "tool_use",
          id: "plan-call",
          name: "updatePlan",
          input: toolArguments,
        },
      ],
      [{ type: "text", text: "First response." }],
      [{ type: "text", text: "Second response." }],
    ]);
    const agent = await createAgent({
      modelStream: streamSimple,
      botConfig: { modelId: "openai/gpt-6-astra", reasoningLevel: "low" },
    });

    await agent.run("first\u0000request and literal \\u0000");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(first.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", isError: false }),
    );
    const firstAssistant = first.messages.find(
      (message) => message.role === "assistant",
    );
    expect(firstAssistant?.content).toMatchObject([
      { type: "thinking", thinkingSignature: "opaque-signature" },
      {
        type: "thinking",
        thinkingSignature: "opaque-redacted-data",
        redacted: true,
      },
      { type: "toolCall", arguments: toolArguments },
    ]);
    const stored = await agent.agentHistory();
    expect(
      JSON.stringify(
        stored.find((message) => message.role === "assistant")?.content,
      ),
    ).toBe(JSON.stringify(firstAssistant?.content));
    expect(stored.slice(0, first.messages.length)).toEqual(first.messages);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.sessionAffinity)).toEqual(
      Array(3).fill(agent.conversationId()),
    );
    const before = requests[1]!;
    const after = requests[2]!;
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
    // The first Turn sends the script tools. The same tools are not sent
    // again.
    const scriptToolsCount = (messages: unknown) =>
      JSON.stringify(messages).split("<script-tools>\\n").length - 1;
    expect(scriptToolsCount(requests[0]!.messages)).toBe(1);
    expect(scriptToolsCount(after.messages)).toBe(1);
    // Do not sort in the assertion: the real provider bytes must already match.
    expect(
      JSON.stringify(
        withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(before.messages)));
  });

  it("sends a capability section again only when it changed", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third.", "Fourth."],
    });
    const newText = (
      before: { messages: unknown[] },
      after: { messages: unknown[] },
    ) => JSON.stringify(after.messages.slice(before.messages.length));
    const count = (text: string, tag: string) =>
      text.split(`<${tag}>\\n`).length - 1;

    await agent.run("first");
    const first = agent.snapshot();
    expect(count(JSON.stringify(first.messages), "workspaces")).toBe(0);
    // A deploy adds a skill, and someone creates a Workspace.
    const removeSkills = await installTestSkills([
      {
        name: "release-notes",
        description: "Write release notes.",
        body: "Write them.",
      },
    ]);
    const workspace = await createWorkspace({
      name: "docs",
      repos: [{ provider: "github", repo: "getsentry/docs" }],
    });
    let third: ReturnType<typeof agent.snapshot>;
    try {
      await agent.run("second");
      const second = agent.snapshot();
      await agent.run("third");
      third = agent.snapshot();

      // The changed sections go after the cached prefix, once.
      expect(second.messages.slice(0, first.messages.length)).toEqual(
        first.messages,
      );
      const changed = newText(first, second);
      expect(changed).toContain("<name>release-notes</name>");
      expect(changed).toContain("- docs: getsentry/docs");
      expect(count(changed, "available-skills")).toBe(1);
      expect(count(changed, "workspaces")).toBe(1);
      expect(count(newText(second, third), "available-skills")).toBe(0);
      expect(count(newText(second, third), "workspaces")).toBe(0);
    } finally {
      await removeSkills();
      await deleteWorkspace(workspace.id);
    }

    // Both changes are undone. An empty section says so.
    await agent.run("fourth");
    const undone = newText(third, agent.snapshot());
    expect(count(undone, "available-skills")).toBe(1);
    expect(undone).not.toContain("release-notes");
    expect(undone).toContain("<workspaces>\\nnone\\n</workspaces>");
  });
});
