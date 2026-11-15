import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  mockAnthropicStream,
  withoutCacheMarkers,
} from "../fixtures/anthropic-stream";
import { connectedState } from "@/chat/cache-warming/request";
import { loadSnapshot, saveSnapshot } from "@/chat/cache-warming/snapshot";
import { botConfig } from "@/chat/config";
import { commitMessages } from "@/chat/conversations/projection";
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
    // This model takes no later system messages, so Pi collapses the
    // capability sections into the system prompt.
    expect(JSON.stringify(requests[0]!.system)).toContain("<script-tools>");
    expect(JSON.stringify(after.messages)).not.toContain("<script-tools>");
    // Do not sort in the assertion: the real provider bytes must already match.
    expect(
      JSON.stringify(
        withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(before.messages)));
  });

  it("replays a saved system message in place on every request", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third."],
    });
    await agent.run("first");
    // No runtime path writes a later system message yet, so commit one as
    // the next history item, where Pi would put it.
    const saved = {
      role: "system" as const,
      content: "Prefer short replies.",
      sections: { skills: "<available-skills>\nnone\n</available-skills>" },
      timestamp: Date.now(),
    };
    const firstHistory = await agent.agentHistory();
    await commitMessages({
      conversationId: agent.conversationId(),
      messages: [...firstHistory, saved],
    });

    await agent.run("second");
    const second = agent.snapshot();
    await agent.run("third");
    const third = agent.snapshot();

    expect((await agent.agentHistory())[firstHistory.length]).toEqual(saved);
    expect(second.messages[firstHistory.length]).toEqual(saved);
    expect(
      JSON.stringify(third.messages.slice(0, second.messages.length)),
    ).toBe(JSON.stringify(second.messages));
    // Cache warming stores this request context and sends it again.
    const state = await connectedState();
    const key = `snapshot:${agent.conversationId()}`;
    await saveSnapshot(state, agent.conversationId(), key, third, 60_000);
    await expect(
      loadSnapshot(state, agent.conversationId(), key),
    ).resolves.toEqual(third);
  });

  it("sends a capability section again only when it changed", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third.", "Fourth."],
    });
    const sectionUpdates = async () =>
      (await agent.agentHistory()).flatMap((message) =>
        message.role === "system" ? [message.sections ?? {}] : [],
      );

    await agent.run("first");
    const first = agent.snapshot();
    const [initial] = await sectionUpdates();
    expect(Object.keys(initial!)).toEqual(
      expect.arrayContaining(["available-skills", "script-tools"]),
    );
    expect(initial).not.toHaveProperty("workspaces");
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
    try {
      await agent.run("second");
      const second = agent.snapshot();
      await agent.run("third");

      // One system message after the cached prefix sets only the changed
      // sections. The next Turn sets none.
      expect(second.messages.slice(0, first.messages.length)).toEqual(
        first.messages,
      );
      const updates = await sectionUpdates();
      expect(updates).toHaveLength(2);
      expect(Object.keys(updates[1]!).sort()).toEqual([
        "available-skills",
        "workspaces",
      ]);
      expect(updates[1]!["available-skills"]).toContain(
        "<name>release-notes</name>",
      );
      expect(updates[1]!["workspaces"]).toContain("- docs: getsentry/docs");
    } finally {
      await removeSkills();
      await deleteWorkspace(workspace.id);
    }

    // Both changes are undone. An empty section is removed.
    await agent.run("fourth");
    const undone = (await sectionUpdates()).at(-1)!;
    expect(Object.keys(undone).sort()).toEqual([
      "available-skills",
      "workspaces",
    ]);
    expect(undone["available-skills"]).not.toContain("release-notes");
    expect(undone["workspaces"]).toBeNull();
  });
});
