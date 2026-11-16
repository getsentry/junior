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
import { signedInViewer } from "../fixtures/user";
import { getSqlExecutor } from "@/chat/db";
import { changePlan, setPlanItemStatusByUser } from "@/chat/plan/store";

const originalBotConfig = { ...botConfig };

describe("model message history", () => {
  afterEach(async () => {
    Object.assign(botConfig, originalBotConfig);
    await closeConversationFixture();
  });
  it("preserves native messages and provider request prefixes across Turns", async () => {
    const toolArguments = {
      message: "Checking the result\u0000before replying.",
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
          id: "progress-call",
          name: "reportProgress",
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

  it("sends plan changes that a person made once, and none for the agent's own", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third.", "Fourth."],
    });
    const newText = (
      before: { messages: unknown[] },
      after: { messages: unknown[] },
    ) => JSON.stringify(after.messages.slice(before.messages.length));
    const deltas = (text: string) => text.split("<plan-delta ").length - 1;

    await agent.run("first");
    const first = agent.snapshot();
    // The agent's own changes are already in its tool results. The plan is
    // in the database, so a fresh session reads the same items.
    const self = { conversationId: agent.conversationId() };
    const [, send] = await changePlan(getSqlExecutor(), {
      conversationId: agent.conversationId(),
      nowMs: Date.now(),
      change: {
        add: [
          { title: "Draft the brief", status: "in_progress", assignee: self },
          { title: "Send the brief", status: "pending", assignee: self },
        ],
        update: [],
        remove: [],
      },
    });
    await agent.run("second");
    const second = agent.snapshot();
    expect(deltas(newText(first, second))).toBe(0);

    const person = await signedInViewer("person@example.com");
    await setPlanItemStatusByUser(getSqlExecutor(), {
      conversationId: agent.conversationId(),
      id: send!.id,
      nowMs: Date.now(),
      status: "cancelled",
      userId: person.id,
    });
    await agent.run("third");
    const third = agent.snapshot();
    const delta = newText(second, third);
    expect(deltas(delta)).toBe(1);
    expect(delta).toContain(
      `<item id=\\"${send!.id}\\" status=\\"cancelled\\" assignee=\\"self\\" author=\\"person@example.com\\" email=\\"person@example.com\\">Send the brief</item>`,
    );
    expect(delta).not.toContain("Draft the brief");
    // The block stays in history, so the next Turn does not send it again.
    await agent.run("fourth");
    expect(deltas(newText(third, agent.snapshot()))).toBe(0);
  });
});
